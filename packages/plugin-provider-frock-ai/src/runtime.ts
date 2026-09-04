import {
  LlmEffectNotStartedError,
  type LlmProvider,
  type LlmReconciliationCapability,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  type ModelRequestDeadlineOptionsV1,
  requestToWire,
  streamWithModelRequestDeadlinesV1,
} from "@frockbot/provider-openai-compatible";
import type { Plugin } from "cordis";
import { FROCK_AI_PROVIDER_TYPE, gatewayModelForFrockIdV1 } from "./catalog.js";

export type OpenAICompatibleChatCompletionBodyV1 = Record<string, unknown>;

/**
 * The narrow native host seam. Cloudflare's generated `Ai` type remains in
 * apps/cloudflare; the Package consumes one streaming gateway operation.
 */
export type FrockAiChatCompletionV1 = (
  gatewayModel: string,
  body: OpenAICompatibleChatCompletionBodyV1,
  /** Cancels the gateway request; the host bounds it with its own deadline. */
  signal?: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

export interface FrockAiRuntimeConfig {
  connectionId: string;
  connectionGeneration: string;
  autoRoute: string;
  runChatCompletion: FrockAiChatCompletionV1;
  /**
   * Deadline overrides and the timer seam behind them. The gateway binding
   * takes no signal of its own, so this is the only bound on a gateway call
   * that accepts the request and then says nothing.
   */
  deadlines?: ModelRequestDeadlineOptionsV1;
}

class FrockAiProvider implements LlmProvider {
  readonly id = FROCK_AI_PROVIDER_TYPE;

  /**
   * The Gateway keeps no addressable copy of a completion, so an interrupted
   * stream can never be read back. Saying so is what lets the run settle as a
   * failure with its partial text intact; staying silent parks it on a
   * retrieval that would never arrive.
   */
  readonly reconciliation: LlmReconciliationCapability = {
    retrieve: async () => ({
      status: "not-retrievable",
      reason:
        "Frock AI keeps no durable copy of an interrupted response, so it cannot be recovered",
    }),
  };

  constructor(private readonly config: FrockAiRuntimeConfig) {}

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    const binding = request.modelBinding;
    if (
      binding?.connectionId !== this.config.connectionId ||
      binding.connectionGeneration !== this.config.connectionGeneration
    ) {
      throw new LlmEffectNotStartedError(
        "Frock AI request has invalid Connection authority",
      );
    }
    signal.throwIfAborted();
    const wire = requestToWire(request);
    const { model: _model, ...body } = wire;
    const gatewayModel = gatewayModelForFrockIdV1(
      request.model,
      this.config.autoRoute,
    );
    // A rejection here happened before a stream existed, so no provider effect
    // was ever begun. That is definitive rather than uncertain: reported as a
    // bare failure it would park the run on a reconciliation this Package
    // cannot perform, and the Bot would stay wedged on a transient gateway
    // error.
    // Both bounds at once, and they are not the same bound. `signal` is the
    // caller's cancellation — a Stop, a superseded Turn — and main's change
    // hands it to the gateway so the request is actually torn down. The
    // deadline seam wraps that with the clock: this transport is a native
    // binding, so a gateway that accepted the request and then went quiet was
    // otherwise bounded by nothing short of the fifteen-minute Turn deadline.
    // The seam's signal is derived from the caller's, so passing it down keeps
    // the cancellation and adds the deadline.
    yield* streamWithModelRequestDeadlinesV1(
      async (deadlineSignal) => {
        try {
          return await this.config.runChatCompletion(
            gatewayModel,
            body,
            deadlineSignal,
          );
        } catch (error) {
          deadlineSignal.throwIfAborted();
          throw new LlmEffectNotStartedError(
            error instanceof Error
              ? error.message
              : "Frock AI request did not reach the gateway",
          );
        }
      },
      signal,
      this.config.deadlines ?? {},
    );
  }
}

export function createFrockAiRuntimePlugin(
  config: FrockAiRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new FrockAiProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

export default createFrockAiRuntimePlugin;
