/**
 * A framework-neutral **model provider** over a Cloudflare Workers AI binding. It holds no
 * **credential**: a binding is authority the platform hands the Worker, not a
 * secret in the plugin list, so an agent running on Cloudflare gets a real model
 * with nothing to configure and nothing to leak (E1, E2, E5).
 */

import {
  aiFrames,
  assembleToolCalls,
  errorOf,
  foldToolCalls,
  textOf,
  withinStall,
} from "./frames";
import type { PartialCall } from "./frames";

/** One tool call in the provider-neutral request and response shape. */
export interface ModelToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** One conversation message accepted by the Workers AI provider. */
export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: Array<ModelToolCall> }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
    };

/** One request from any agent runtime to this host-level provider. */
export interface ModelRequest {
  turn: number;
  step: number;
  system: string;
  messages: Array<ModelMessage>;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  options: Record<string, unknown>;
}

/** One streamed provider response item. */
export type ModelChunk =
  { kind: "text"; text: string } | { kind: "tool-call"; call: ModelToolCall };

/** The structural provider returned for an example runtime to register. */
export interface WorkersAiModel {
  readonly name: string;
  stream: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ModelChunk>;
}

/**
 * The Workers AI binding, by the shape this package uses rather than by name,
 * so nothing here depends on `@cloudflare/workers-types`. A real `AI` binding
 * satisfies it, and so does anything else that answers `run`.
 */
export interface WorkersAiBinding {
  run: (
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Settings passed straight through to the model. */
export interface WorkersAiModelSettings {
  max_tokens?: number;
  temperature?: number;
}

/** What the provider needs. Note that none of it is a secret. */
export interface WorkersAiOptions {
  /** The Workers AI binding, from `env`. */
  binding: WorkersAiBinding;
  /** The model to run. Defaults to {@link defaultWorkersAiModel}. */
  model?: string;
  /** The provider's name, as it appears in the registry. Defaults to the model. */
  name?: string;
  /** Settings sent with every request, under the loop's own `modelOptions`. */
  options?: WorkersAiModelSettings;
  /**
   * How long the binding may go quiet, before answering or between frames,
   * before the step ends in error. Defaults to 30 000 ms; `0` waits forever.
   */
  stallMs?: number;
}

/**
 * The model the provider runs when none is named: a current Llama instruct model
 * that supports both function calling and streaming, which is the pair the loop
 * needs. Name another in `model` to run another.
 */
export const defaultWorkersAiModel = "@cf/zai-org/glm-5.3-flash";

interface ResolvedOptions {
  binding: WorkersAiBinding;
  model: string;
  name: string;
  options: Record<string, unknown>;
  stallMs: number;
}

const resolveOptions = (options: WorkersAiOptions): ResolvedOptions => {
  if (typeof options.binding.run !== "function") {
    throw new Error(
      "@frockbot/compose-cloudflare: a Workers AI binding with run() is required",
    );
  }
  const model = options.model ?? defaultWorkersAiModel;
  const stallMs = options.stallMs ?? 30_000;
  if (typeof stallMs !== "number" || !Number.isFinite(stallMs) || stallMs < 0) {
    throw new Error(
      "@frockbot/compose-cloudflare: stallMs must be a number of milliseconds, 0 or more",
    );
  }
  return {
    binding: options.binding,
    model,
    name: options.name ?? model,
    options: { ...options.options },
    stallMs,
  };
};

/** Our messages in the shape a text-generation model reads. */
const toAiMessages = (
  system: string,
  messages: ReadonlyArray<ModelMessage>,
): Array<Record<string, unknown>> => {
  const wire: Array<Record<string, unknown>> = [];
  if (system !== "") wire.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      wire.push({
        role: "assistant",
        content: message.content,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args ?? {}),
                },
              })),
            }
          : {}),
      });
    } else {
      // A tool result is what the next step is for: the model asked, the loop
      // ran the tool, and this is the answer it reads (B2, D2).
      wire.push({
        role: "tool",
        name: message.name,
        tool_call_id: message.callId,
        content: message.content,
      });
    }
  }
  return wire;
};

/** The inputs for one step. */
const toAiInputs = (
  options: ResolvedOptions,
  request: ModelRequest,
): Record<string, unknown> => ({
  messages: toAiMessages(request.system, request.messages),
  stream: true,
  ...(request.tools.length > 0
    ? {
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      }
    : {}),
  ...options.options,
  ...request.options,
});

/**
 * Stream one response. Text is yielded as it arrives so the session records it
 * chunk by chunk; tool calls are yielded once the stream has ended, because a
 * call's arguments may have been split across any number of frames (E1).
 */
async function* streamRun(
  options: ResolvedOptions,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelChunk> {
  const answer = await withinStall(
    options.binding.run(options.model, toAiInputs(options, request), {
      signal,
    }),
    options.stallMs,
  );

  const partials = new Map<number, PartialCall>();
  for await (const frame of aiFrames(answer, signal, options.stallMs)) {
    const failure = errorOf(frame);
    if (failure !== undefined) {
      throw new Error(`@frockbot/compose-cloudflare: ${failure}`);
    }
    const text = textOf(frame);
    if (text !== "") yield { kind: "text", text };
    foldToolCalls(frame, partials);
  }

  for (const call of assembleToolCalls(partials)) {
    yield { kind: "tool-call", call };
  }
}

/**
 * Build a **model provider** backed by a Workers AI binding. Registration in a
 * model registry is the caller's concern, keeping that agent runtime out of
 * this host package.
 *
 * @example
 * ```ts
 * const provider = createWorkersAiModel({ binding: env.AI })
 * modelRegistry.register(provider)
 * ```
 */
export const createWorkersAiModel = (
  options: WorkersAiOptions,
): WorkersAiModel => {
  const resolved = resolveOptions(options);
  return {
    name: resolved.name,
    stream: (request, signal) => streamRun(resolved, request, signal),
  };
};
