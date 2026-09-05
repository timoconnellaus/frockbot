/**
 * A chat-completions route over a Workers AI binding.
 *
 * The **model provider** in `workers-ai.ts` is what a client running *on* the
 * Worker uses. A client running in the browser cannot hold a binding, so it runs
 * `@frockbot/compose-agent` pointed at its own origin, and this is the
 * route that answers: it takes the request that provider sends and returns the
 * chunk stream that provider parses, with the binding — and therefore the whole
 * of the account's authority — staying on the server. No **credential** crosses
 * to the page, because there is none to cross (E5).
 */

import {
  aiFrames,
  assembleToolCalls,
  errorOf,
  foldToolCalls,
  textOf,
  withinStall,
} from "./frames";
import { defaultWorkersAiModel } from "./workers-ai";
import type { PartialCall } from "./frames";
import type { WorkersAiBinding } from "./workers-ai";

/** How the route behaves. */
export interface ChatCompletionsOptions {
  /** The model to run when the request names none. */
  model?: string;
  /**
   * Answer with permissive `access-control-allow-*` headers, and answer a
   * preflight. Off by default: a page served from the same origin as this route
   * needs none, and a route that hands itself to every origin is a route anyone
   * can spend the account's inference on.
   */
  cors?: boolean;
  /**
   * How long the binding may go quiet, before answering or between frames,
   * before the request fails. Defaults to 30 000 ms; `0` waits forever.
   */
  stallMs?: number;
}

/** The body the chat-completions protocol sends. */
interface ChatCompletionsBody {
  model?: string;
  stream?: boolean;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const headersFor = (
  options: ChatCompletionsOptions,
  own: Record<string, string>,
): Record<string, string> => ({ ...own, ...(options.cors ? corsHeaders : {}) });

const failure = (
  status: number,
  message: string,
  options: ChatCompletionsOptions,
): Response =>
  new Response(
    JSON.stringify({ error: { message, type: "invalid_request" } }),
    {
      status,
      headers: headersFor(options, { "content-type": "application/json" }),
    },
  );

const encoder = new TextEncoder();
const frame = (payload: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

/** One chunk of the answer, in the shape the chat-completions protocol streams. */
const chunkOf = (delta: unknown, finish?: string) => ({
  id: "chatcmpl-workers-ai",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
});

/**
 * Answer one chat-completions request out of the Workers AI binding.
 *
 * @example
 * ```ts
 * if (url.pathname === '/ai/chat/completions') {
 *   return handleChatCompletions(request, env.AI)
 * }
 * ```
 */
export async function handleChatCompletions(
  request: Request,
  binding: WorkersAiBinding,
  options: ChatCompletionsOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS" && options.cors) {
    return new Response(null, {
      status: 204,
      headers: headersFor(options, {}),
    });
  }
  if (request.method !== "POST") {
    return failure(405, "this route takes a POST", options);
  }

  let body: ChatCompletionsBody;
  try {
    body = (await request.json()) as ChatCompletionsBody;
  } catch {
    return failure(400, "the request body is not JSON", options);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return failure(400, "the request needs a non-empty `messages`", options);
  }

  const model = body.model ?? options.model ?? defaultWorkersAiModel;
  // Everything but `stream` is what the caller sent: the binding reads the same
  // message and tool shapes the chat-completions protocol uses, so the route
  // rewrites nothing and there is no second dialect to keep in step.
  const inputs: Record<string, unknown> = {
    messages: body.messages,
    stream: true,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice === undefined
      ? {}
      : { tool_choice: body.tool_choice }),
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.temperature === undefined
      ? {}
      : { temperature: body.temperature }),
  };

  const stallMs = options.stallMs ?? 30_000;
  let answer: unknown;
  try {
    answer = await withinStall(
      binding.run(model, inputs, { signal: request.signal }),
      stallMs,
    );
  } catch (error) {
    return failure(
      502,
      `Workers AI refused the request: ${error instanceof Error ? error.message : String(error)}`,
      options,
    );
  }
  if (body.stream !== true) {
    let text = "";
    const partials = new Map<number, PartialCall>();
    for await (const each of aiFrames(answer, request.signal, stallMs)) {
      const failed = errorOf(each);
      if (failed !== undefined) return failure(502, failed, options);
      text += textOf(each);
      foldToolCalls(each, partials);
    }
    const calls = assembleToolCalls(partials);
    return Response.json(
      {
        id: "chatcmpl-workers-ai",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              ...(calls.length > 0
                ? {
                    tool_calls: calls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args),
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: calls.length > 0 ? "tool_calls" : "stop",
          },
        ],
      },
      { headers: headersFor(options, {}) },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const partials = new Map<number, PartialCall>();
      try {
        controller.enqueue(frame(chunkOf({ role: "assistant", content: "" })));
        for await (const each of aiFrames(answer, request.signal, stallMs)) {
          const failed = errorOf(each);
          if (failed !== undefined) {
            // A failure that arrives mid-stream is a frame, not a status: the
            // status went out with the first byte. The provider reads it and
            // the step ends with an error entry (E1).
            controller.enqueue(
              frame({ error: { message: failed, type: "server_error" } }),
            );
            controller.close();
            return;
          }
          const text = textOf(each);
          if (text !== "")
            controller.enqueue(frame(chunkOf({ content: text })));
          foldToolCalls(each, partials);
        }

        // Tool calls are sent whole, once, because the binding may have handed
        // them over that way; the provider assembles pieces just as happily.
        const calls = assembleToolCalls(partials);
        calls.forEach((call, index) => {
          controller.enqueue(
            frame(
              chunkOf({
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args),
                    },
                  },
                ],
              }),
            ),
          );
        });
        controller.enqueue(
          frame(chunkOf({}, calls.length > 0 ? "tool_calls" : "stop")),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.enqueue(
          frame({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: "server_error",
            },
          }),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: headersFor(options, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    }),
  });
}
