import {
  boundedModelProviderReasonV1,
  type LlmProvider,
  type LlmReconciliationCapability,
  type LlmStreamEvent,
  ModelProviderFailureError,
  type ModelProviderFailureClassV1,
  ModelRequestDeadlineError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  classifyOpenAICompatibleFailureV1,
  type ModelRequestDeadlineOptionsV1,
  planOpenAICompatibleRequestV1,
  streamWithModelRequestDeadlinesV1,
} from "@frockbot/provider-openai-compatible";
import type { Agent } from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_PROVIDER_TYPE,
  gatewayModelForFrockRequestV1,
  normalizeFrockModelIdV1,
} from "./catalog.js";

export type OpenAICompatibleChatCompletionBodyV1 = Record<string, unknown>;

/** The small error shape the Cloudflare host carries across this seam. */
export class FrockAiTransportErrorV1 extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly code?: string | number,
  ) {
    super(boundedModelProviderReasonV1(message));
    this.name = "FrockAiTransportErrorV1";
  }
}

function errorRecordV1(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Map both AI Gateway and Workers AI error envelopes to the model contract. */
export function classifyFrockAiFailureV1(
  error: unknown,
): ModelProviderFailureError {
  if (error instanceof ModelProviderFailureError) return error;
  const outer = errorRecordV1(error);
  const nested = errorRecordV1(outer?.error);
  const status =
    error instanceof FrockAiTransportErrorV1
      ? error.status
      : typeof outer?.status === "number"
        ? outer.status
        : undefined;
  const code =
    error instanceof FrockAiTransportErrorV1
      ? error.code
      : (nested?.code ?? outer?.code);
  const reason =
    error instanceof Error
      ? error.message
      : typeof nested?.message === "string"
        ? nested.message
        : typeof outer?.message === "string"
          ? outer.message
          : "Frock AI request did not reach the provider";
  const words = `${String(code ?? "")} ${reason}`;
  let classification: ModelProviderFailureClassV1;
  if (status !== undefined) {
    classification = classifyOpenAICompatibleFailureV1(
      status,
      typeof code === "string" ? code : undefined,
    );
  } else if (
    /rate|overload|temporar|unavailable|timeout|timed out|gateway|reset/i.test(
      words,
    )
  ) {
    classification = "transient";
  } else if (
    /invalid|unauthor|forbidden|credential|not found|unknown model|content|safety|policy/i.test(
      words,
    )
  ) {
    classification = "permanent";
  } else {
    classification = "unknown";
  }
  return new ModelProviderFailureError({
    classification,
    reason,
    ...(error instanceof FrockAiTransportErrorV1 &&
    error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  });
}

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
  readonly supports = { structuredOutput: "json_schema" } as const;
  readonly autoFallbackFailures = new WeakSet<ModelProviderFailureError>();

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

  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const binding = request.modelBinding;
    if (
      binding?.connectionId !== this.config.connectionId ||
      binding.connectionGeneration !== this.config.connectionGeneration
    ) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Frock AI request has invalid Connection authority",
      });
    }
    signal.throwIfAborted();
    const auto =
      normalizeFrockModelIdV1(request.model) === FROCK_AI_DEFAULT_MODEL;
    const plan = planOpenAICompatibleRequestV1(request, {
      structuredOutput: auto ? "json_schema" : "none",
      responseFormatDialect: "workers-ai",
    });
    if (plan.note) yield { type: "response-format-note", note: plan.note };
    const { model: _model, ...body } = plan.body;
    const gatewayModel = gatewayModelForFrockRequestV1(
      request.model,
      request.responseFormat !== undefined,
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
    try {
      yield* streamWithModelRequestDeadlinesV1(
        (deadlineSignal) =>
          this.config.runChatCompletion(gatewayModel, body, deadlineSignal),
        signal,
        this.config.deadlines ?? {},
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ModelRequestDeadlineError) {
        if (error.phase === "idle") throw error;
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: error.message,
        });
      }
      const failure = classifyFrockAiFailureV1(error);
      if (
        failure.classification === "permanent" &&
        request.model !== FROCK_AI_DEFAULT_MODEL
      ) {
        this.autoFallbackFailures.add(failure);
      }
      throw failure;
    }
  }
}

export function createFrockAiRuntimePlugin(
  config: FrockAiRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const provider = new FrockAiProvider(config);
    const fallbackAgents = new WeakSet<Agent>();
    const disposeProvider = ctx.llm.register(provider);
    const disposeFailure = ctx.on(
      "agent/request-error",
      async (agent, error, _signal, next) => {
        if (
          !(error instanceof ModelProviderFailureError) ||
          !provider.autoFallbackFailures.has(error)
        ) {
          return next();
        }
        fallbackAgents.add(agent);
        return { kind: "fallback" } as const;
      },
    );
    const disposeRequest = ctx.on(
      "agent/request",
      async (agent, _request, _signal, next) => {
        const request = await next();
        return fallbackAgents.has(agent)
          ? { ...request, model: FROCK_AI_DEFAULT_MODEL }
          : request;
      },
    );
    const disposeTurn = ctx.on("agent/turn-stopping", async (agent) => {
      fallbackAgents.delete(agent);
    });
    return () => {
      disposeTurn();
      disposeRequest();
      disposeFailure();
      disposeProvider();
    };
  };
  plugin.inject = ["llm"];
  return plugin;
}

export default createFrockAiRuntimePlugin;
