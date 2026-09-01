import {
  LlmEffectNotStartedError,
  type LlmProvider,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  requestToWire,
  streamOpenAICompatibleBody,
} from "@frockbot/provider-openai-compatible";
import type { Plugin } from "cordis";
import { WORKERS_AI_PROVIDER_TYPE } from "./catalog.js";

/**
 * The narrow native host seam. Cloudflare's generated `Ai` type remains in
 * apps/cloudflare; the Package depends only on the one operation it consumes.
 */
export type WorkersAiRunV1 = (
  model: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface WorkersAiRuntimeConfig {
  connectionId: string;
  connectionGeneration: string;
  run: WorkersAiRunV1;
}

function responseBody(value: unknown): ReadableStream<Uint8Array> {
  if (value instanceof ReadableStream) {
    return value as ReadableStream<Uint8Array>;
  }
  if (value instanceof Response && value.body) return value.body;
  if (value && typeof value === "object" && "body" in value) {
    const body = (value as { body?: unknown }).body;
    if (body instanceof ReadableStream) {
      return body as ReadableStream<Uint8Array>;
    }
  }
  throw new Error("Workers AI did not return a response stream");
}

class WorkersAiProvider implements LlmProvider {
  readonly id = WORKERS_AI_PROVIDER_TYPE;

  constructor(private readonly config: WorkersAiRuntimeConfig) {}

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    const binding = request.modelBinding;
    if (
      binding?.connectionId !== this.config.connectionId ||
      binding.connectionGeneration !== this.config.connectionGeneration
    ) {
      throw new LlmEffectNotStartedError(
        "Workers AI request has invalid Connection authority",
      );
    }
    signal.throwIfAborted();
    const wire = requestToWire(request);
    const { model: _model, ...input } = wire;
    const body = responseBody(await this.config.run(request.model, input));
    try {
      yield* streamOpenAICompatibleBody(body, signal);
    } catch (error) {
      if (signal.aborted)
        await body.cancel(signal.reason).catch(() => undefined);
      throw error;
    }
  }
}

export function createWorkersAiRuntimePlugin(
  config: WorkersAiRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new WorkersAiProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

export default createWorkersAiRuntimePlugin;
