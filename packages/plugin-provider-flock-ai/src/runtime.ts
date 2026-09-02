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
import { FLOCK_AI_PROVIDER_TYPE, gatewayModelForFlockIdV1 } from "./catalog.js";

export type OpenAICompatibleChatCompletionBodyV1 = Record<string, unknown>;

/**
 * The narrow native host seam. Cloudflare's generated `Ai` type remains in
 * apps/cloudflare; the Package consumes one streaming gateway operation.
 */
export type FlockAiChatCompletionV1 = (
  gatewayModel: string,
  body: OpenAICompatibleChatCompletionBodyV1,
) => Promise<ReadableStream<Uint8Array>>;

export interface FlockAiRuntimeConfig {
  connectionId: string;
  connectionGeneration: string;
  autoRoute: string;
  runChatCompletion: FlockAiChatCompletionV1;
}

class FlockAiProvider implements LlmProvider {
  readonly id = FLOCK_AI_PROVIDER_TYPE;

  constructor(private readonly config: FlockAiRuntimeConfig) {}

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    const binding = request.modelBinding;
    if (
      binding?.connectionId !== this.config.connectionId ||
      binding.connectionGeneration !== this.config.connectionGeneration
    ) {
      throw new LlmEffectNotStartedError(
        "Flock AI request has invalid Connection authority",
      );
    }
    signal.throwIfAborted();
    const wire = requestToWire(request);
    const { model: _model, ...body } = wire;
    const gatewayModel = gatewayModelForFlockIdV1(
      request.model,
      this.config.autoRoute,
    );
    const responseBody = await this.config.runChatCompletion(
      gatewayModel,
      body,
    );
    try {
      yield* streamOpenAICompatibleBody(responseBody, signal);
    } catch (error) {
      if (signal.aborted) {
        await responseBody.cancel(signal.reason).catch(() => undefined);
      }
      throw error;
    }
  }
}

export function createFlockAiRuntimePlugin(
  config: FlockAiRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new FlockAiProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

export default createFlockAiRuntimePlugin;
