import {
  type LlmMessage,
  type LlmProvider,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OpenAICompatibleHttpError extends Error {
  constructor(readonly status: number) {
    super(`Model request failed (${status})`);
    this.name = "OpenAICompatibleHttpError";
  }
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /**
   * Whether this endpoint's model accepts image content. Absent, and the
   * model id decides through {@link modelAcceptsImagesV1}.
   */
  acceptsImages?: boolean;
  /**
   * Deadline for the model request's response headers. The stream that follows
   * is bounded separately, per read, by {@link SSE_IDLE_READ_TIMEOUT_MS}.
   */
  firstByteTimeoutMs?: number;
  /** Per-read deadline once the stream is open. */
  idleReadTimeoutMs?: number;
}

/** Deadline for a model request's response headers. */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60_000;

interface ToolAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Model families this adapter will hand an image to.
 *
 * A guess, and named as one: there is no capability field on the wire and no
 * catalog this adapter can consult, so the default is a list of families whose
 * documented input includes images. `acceptsImages` overrides it in both
 * directions, which is what a deployment that knows better sets.
 */
const VISION_MODEL_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /o[34]\b/i,
  /claude-/i,
  /gemini-/i,
  /vision/i,
  /-vl\b/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
];

/** Whether this adapter will show `model` an image attachment. */
export function modelAcceptsImagesV1(model: string): boolean {
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function dataUrl(mediaType: string, dataBase64: string): string {
  return `data:${mediaType};base64,${dataBase64}`;
}

function messageToWire(
  message: LlmMessage,
  acceptsImages: boolean,
): Record<string, unknown>[] {
  if (message.role === "user")
    return [{ role: "user", content: message.content }];
  if (message.role === "tool") {
    const attachments = message.attachments ?? [];
    // An attachment this adapter cannot show is said in the text rather than
    // dropped in silence: a Bot that asked for a screenshot has to be able to
    // tell "the model saw it" from "the model was told where it is".
    const shown = acceptsImages
      ? attachments.filter((attachment) => attachment.dataBase64 !== undefined)
      : [];
    const withheld = attachments.filter(
      (attachment) => !shown.includes(attachment),
    );
    const notes = withheld.map(
      (attachment) =>
        `[attachment ${attachment.mediaType} not shown to this model; it is at ${attachment.workspacePath.path} (sha256 ${attachment.contentHash})]`,
    );
    const tool = {
      role: "tool",
      tool_call_id: message.callId,
      content: [message.content, ...notes].filter(Boolean).join("\n"),
    };
    if (shown.length === 0) return [tool];
    // The image travels as a following user message rather than inside the
    // tool result: an OpenAI-shaped `tool` message takes text, and a content
    // array there is refused by the very endpoints that accept the image.
    return [
      tool,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Attachments from ${message.name}:`,
          },
          ...shown.map((attachment) => ({
            type: "image_url",
            image_url: {
              url: dataUrl(attachment.mediaType, attachment.dataBase64!),
            },
          })),
        ],
      },
    ];
  }
  return [
    {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            })),
          }
        : {}),
    },
  ];
}

export function requestToWire(
  request: NormalizedModelRequest,
  options: { acceptsImages?: boolean } = {},
): Record<string, unknown> {
  const acceptsImages =
    options.acceptsImages ?? modelAcceptsImagesV1(request.model);
  const messages: Record<string, unknown>[] = [];
  if (request.system)
    messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    messages.push(...messageToWire(message, acceptsImages));
  }
  return {
    model: request.model,
    stream: true,
    messages,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

const MAX_SSE_EVENT_CHARACTERS = 1_048_576;
const MAX_SSE_RESPONSE_BYTES = 16_777_216;
/**
 * A provider that opens a stream and then stalls holds the Turn open until the
 * caller aborts, which for an unattended run is never. Each individual read is
 * bounded instead, so a silent stream fails as a stream rather than hanging.
 */
export const SSE_IDLE_READ_TIMEOUT_MS = 120_000;

class SseIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Model response stream stalled for ${idleMs}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

/** Resolve to the read, or reject once the idle deadline passes. */
async function readWithin<T>(
  read: Promise<T>,
  idleMs: number,
): Promise<Awaited<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SseIdleTimeoutError(idleMs)),
          idleMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function rejectOversizedSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<never> {
  await reader.cancel().catch(() => undefined);
  throw new Error("Model response stream exceeded its size limit");
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number = SSE_IDLE_READ_TIMEOUT_MS,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await readWithin(reader.read(), idleMs));
      } catch (error) {
        if (error instanceof SseIdleTimeoutError) {
          await reader.cancel(error.message).catch(() => undefined);
        }
        throw error;
      }
      signal.throwIfAborted();
      responseBytes += value?.byteLength ?? 0;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        await rejectOversizedSse(reader);
      }
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      if (
        buffer.length > MAX_SSE_EVENT_CHARACTERS ||
        blocks.some((block) => block.length > MAX_SSE_EVENT_CHARACTERS)
      ) {
        await rejectOversizedSse(reader);
      }
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function applyToolDeltas(
  value: unknown,
  tools: Map<number, ToolAccumulator>,
): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const delta = asRecord(candidate);
    if (!delta || typeof delta.index !== "number") continue;
    const current = tools.get(delta.index) ?? {
      index: delta.index,
      id: "",
      name: "",
      arguments: "",
    };
    if (typeof delta.id === "string") current.id = delta.id;
    const fn = asRecord(delta.function);
    if (typeof fn?.name === "string") current.name += fn.name;
    if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
    tools.set(delta.index, current);
  }
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`${label}: ${String(error)}`);
  }
}

function parseToolInput(value: string): JsonValue {
  return value ? parseJson(value, "Model returned invalid tool arguments") : {};
}

/**
 * Normalize an OpenAI-compatible SSE body. Native provider bindings can reuse
 * this wire decoder without pretending their in-process call is HTTP.
 */
export async function* streamOpenAICompatibleBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleMs: number = SSE_IDLE_READ_TIMEOUT_MS,
): AsyncIterable<LlmStreamEvent> {
  const tools = new Map<number, ToolAccumulator>();
  let finishReason: string | undefined;
  let terminal = false;
  let sawChoice = false;
  for await (const data of readSseData(body, signal, idleMs)) {
    if (data === "[DONE]") {
      terminal = true;
      break;
    }
    const payload = asRecord(
      parseJson(data, "Model returned an invalid stream event"),
    );
    const choices = payload?.choices;
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const delta = asRecord(choice?.delta);
    if (choice && (delta || typeof choice.finish_reason === "string")) {
      sawChoice = true;
    }
    if (typeof delta?.content === "string" && delta.content) {
      yield { type: "text-delta", text: delta.content };
    }
    applyToolDeltas(delta?.tool_calls, tools);
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
      terminal = true;
    }
  }
  if (!terminal) {
    throw new Error("Model response stream ended before a terminal marker");
  }
  if (!sawChoice) {
    throw new Error("Model response stream did not include a valid choice");
  }

  for (const tool of [...tools.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    if (!tool.name)
      throw new Error("Model returned a tool call without a name");
    yield {
      type: "tool-call",
      call: {
        id: tool.id || crypto.randomUUID(),
        name: tool.name,
        input: parseToolInput(tool.arguments),
      },
    };
  }
  yield {
    type: "finish",
    reason:
      tools.size > 0 || finishReason === "tool_calls"
        ? "tool-calls"
        : finishReason === "length"
          ? "max-tokens"
          : "completed",
  };
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.baseUrl.trim())
      throw new Error("OpenAI-compatible baseUrl is required");
    this.id = config.providerId ?? "openai-compatible";
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    // Workerd rejects a detached global `fetch` ("Illegal invocation"), so the
    // default fetcher forwards through a closure rather than aliasing it.
    const fetcher =
      this.config.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey)
      headers.authorization = `Bearer ${this.config.apiKey}`;
    // The deadline covers the headers only, and is cleared the moment they
    // arrive: aborting the shared signal later would tear down a stream that is
    // legitimately still producing tokens.
    const firstByteMs =
      this.config.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    const headersController = new AbortController();
    const requestSignal = AbortSignal.any([signal, headersController.signal]);
    const headersTimer = setTimeout(() => {
      headersController.abort(
        new Error(`Model request did not respond within ${firstByteMs}ms`),
      );
    }, firstByteMs);
    let response: Response;
    try {
      response = await fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          requestToWire(request, {
            ...(this.config.acceptsImages === undefined
              ? {}
              : { acceptsImages: this.config.acceptsImages }),
          }),
        ),
        signal: requestSignal,
      });
    } catch (error) {
      if (headersController.signal.aborted && !signal.aborted) {
        throw new Error(
          `Model request did not respond within ${firstByteMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(headersTimer);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenAICompatibleHttpError(response.status);
    }
    if (!response.body)
      throw new Error("Model response did not include a stream");

    yield* streamOpenAICompatibleBody(
      response.body,
      signal,
      this.config.idleReadTimeoutMs ?? SSE_IDLE_READ_TIMEOUT_MS,
    );
  }
}

export function createOpenAICompatiblePlugin(
  config: OpenAICompatibleConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new OpenAICompatibleProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}
