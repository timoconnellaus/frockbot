import {
  type AgentRuntimeV1,
  boundedModelProviderReasonV1,
  type LlmProvider,
  type LlmStreamEvent,
  ModelProviderFailureError,
  type ModelProviderFailureClassV1,
  ModelRequestDeadlineError,
  type LoopAgentRuntimeV1,
  type NormalizedModelRequest,
  type RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import {
  classifyOpenAICompatibleFailureV1,
  type ModelRequestDeadlineOptionsV1,
  planOpenAICompatibleRequestV1,
  streamWithModelRequestDeadlinesV1,
} from "@frockbot/providers/openai-compatible";
import {
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_PROVIDER_TYPE,
  FROCK_AI_SUMMARY_MODEL,
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
 * Which model the Gateway actually ran for one request. Auto is a route the
 * Gateway resolves, so this — not the requested id — is what the call cost.
 */
export interface FrockAiServedModelV1 {
  /** `<provider>/<model>`, absent when the Gateway named neither. */
  model?: string;
  /** Answered from the Gateway's cache: no provider ran. */
  cached: boolean;
}

function gatewayHeaderV1(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value && /^[\x21-\x7e]{1,200}$/.test(value) ? value : undefined;
}

/** Read the served model from the headers every Gateway answer carries. */
export function frockAiServedModelFromHeadersV1(
  headers: Headers,
): FrockAiServedModelV1 {
  const provider = gatewayHeaderV1(headers, "cf-aig-provider");
  const model = gatewayHeaderV1(headers, "cf-aig-model");
  return {
    ...(provider && model ? { model: `${provider}/${model}` } : {}),
    cached: headers.get("cf-aig-cache-status")?.trim().toUpperCase() === "HIT",
  };
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
  /** Told which model answered, as soon as the Gateway's answer arrives. */
  served?: (model: FrockAiServedModelV1) => void,
) => Promise<ReadableStream<Uint8Array>>;

export interface FrockAiRuntimeConfig {
  connectionId: string;
  connectionGeneration: string;
  /** `null` on a transport with no dynamic route; Auto is a pinned model there. */
  autoRoute: string | null;
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
  readonly summaryModel;
  /** Read back by billing through {@link frockAiServedModelV1}. */
  readonly servedModels = new WeakMap<
    NormalizedModelRequest,
    FrockAiServedModelV1
  >();

  /**
   * The Gateway keeps no addressable copy of a completion, so an interrupted
   * stream can never be read back. Saying so is what lets the run settle as a
   * failure with its partial text intact; staying silent parks it on a
   * retrieval that would never arrive.
   */
  constructor(private readonly config: FrockAiRuntimeConfig) {
    this.summaryModel = {
      model: FROCK_AI_SUMMARY_MODEL,
      modelBinding: {
        connectionId: config.connectionId,
        connectionGeneration: config.connectionGeneration,
      },
    };
  }

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
      // Auto's gateway route serves a model that reads images. A schema
      // request is pinned to a text model instead, and the `AI` binding path
      // has no route at all, so neither is sent one.
      acceptsImages:
        auto &&
        this.config.autoRoute !== null &&
        request.responseFormat === undefined,
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
    // caller's cancellation — a Stop, a Turn deadline — and main's change
    // hands it to the gateway so the request is actually torn down. The
    // deadline seam wraps that with the clock: this transport is a native
    // binding, so a gateway that accepted the request and then went quiet was
    // otherwise bounded by nothing short of the fifteen-minute Turn deadline.
    // The seam's signal is derived from the caller's, so passing it down keeps
    // the cancellation and adds the deadline.
    try {
      yield* streamWithModelRequestDeadlinesV1(
        (deadlineSignal) =>
          this.config.runChatCompletion(
            gatewayModel,
            body,
            deadlineSignal,
            (served) => this.servedModels.set(request, served),
          ),
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

/**
 * Frock AI as the summariser beside a Bot on another provider: the provider
 * alone, so its Auto fallback never touches the Bot's own requests. A Turn
 * already on Frock AI has the provider, and this mounts nothing.
 */
export function createFrockAiSummaryFeature(
  config: FrockAiRuntimeConfig,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    if (runtime.llm.get(FROCK_AI_PROVIDER_TYPE)) return () => {};
    return runtime.llm.register(new FrockAiProvider(config));
  };
}

/**
 * The model that answered `request`, when `provider` is the Frock AI provider
 * that sent it and the Gateway has answered.
 *
 * Billing asks this rather than reading a stream event: the model stream is
 * also what a Plugin model provider answers with, and which model the hosted
 * Gateway ran is not a Plugin's to say or to see.
 */
export function frockAiServedModelV1(
  provider: LlmProvider,
  request: NormalizedModelRequest,
): FrockAiServedModelV1 | undefined {
  return provider instanceof FrockAiProvider
    ? provider.servedModels.get(request)
    : undefined;
}

export function createFrockAiFeature(
  config: FrockAiRuntimeConfig,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const provider = new FrockAiProvider(config);
    const fallbackAgents = new WeakSet<LoopAgentRuntimeV1>();
    const disposeProvider = runtime.llm.register(provider);
    const disposeHooks = runtime.hooks.add({
      requestError: async (agent, error, _signal, next) => {
        if (
          !(error instanceof ModelProviderFailureError) ||
          !provider.autoFallbackFailures.has(error)
        ) {
          return next();
        }
        fallbackAgents.add(agent);
        return { kind: "fallback" } as const;
      },
      request: async (agent, _request, _turn, _step, _signal, next) => {
        const request = await next();
        return fallbackAgents.has(agent)
          ? { ...request, model: FROCK_AI_DEFAULT_MODEL }
          : request;
      },
      turnStopping: async (agent) => {
        fallbackAgents.delete(agent);
      },
    });
    return () => {
      disposeHooks();
      disposeProvider();
    };
  };
}

export default createFrockAiFeature;
