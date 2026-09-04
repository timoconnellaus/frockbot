import {
  LlmEffectNotStartedError,
  type LlmProvider,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  type ModelRequestDeadlineOptionsV1,
  requestToWire,
  streamWithModelRequestDeadlinesV1,
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
  /**
   * Deadline overrides and the timer seam behind them. The gateway binding
   * takes no signal of its own, so this is the only bound on a gateway call
   * that accepts the request and then says nothing.
   */
  deadlines?: ModelRequestDeadlineOptionsV1;
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
    // A rejection here happened before a stream existed, so no provider effect
    // was ever begun. That is definitive rather than uncertain: reported as a
    // bare failure it would park the run on a reconciliation this Package
    // cannot perform, and the Bot would stay wedged on a transient gateway
    // error.
    // The deadlines live in the shared seam rather than here: this transport
    // is a native binding with no signal of its own, so without it a gateway
    // that accepted the request and went quiet was bounded by nothing short of
    // the fifteen-minute Turn deadline.
    yield* streamWithModelRequestDeadlinesV1(
      async (deadlineSignal) => {
        try {
          return await this.config.runChatCompletion(gatewayModel, body);
        } catch (error) {
          deadlineSignal.throwIfAborted();
          throw new LlmEffectNotStartedError(
            error instanceof Error
              ? error.message
              : "Flock AI request did not reach the gateway",
          );
        }
      },
      signal,
      this.config.deadlines ?? {},
    );
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
