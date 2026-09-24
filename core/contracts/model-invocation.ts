import type {
  LlmStreamEvent,
  ModelBindingSnapshot,
  NormalizedModelRequest,
} from "./types.js";
import type {
  JsonSchemaResponseFormatV1,
  ModelProviderSupportsV1,
  StructuredOutputFailureV1,
  StructuredModelResultV1,
} from "./structured-output.js";

export class StructuredOutputValidationError extends Error {
  constructor(readonly failure: StructuredOutputFailureV1) {
    super(failure.message);
    this.name = "StructuredOutputValidationError";
  }
}

export interface DurableModelEffect {
  providerEffectId: string;
  request: NormalizedModelRequest;
}

export const MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1 = 500;

export type ModelProviderFailureClassV1 = "transient" | "permanent" | "unknown";

/** Keep provider diagnostics useful without letting an envelope grow the log. */
export function boundedModelProviderReasonV1(reason: unknown): string {
  const value =
    typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "The model provider did not give a reason";
  return value.slice(0, MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1);
}

/** A definitive provider failure raised before response bytes were emitted. */
export class ModelProviderFailureError extends Error {
  readonly classification: ModelProviderFailureClassV1;
  readonly providerReason: string;
  readonly retryAfterMs?: number;

  constructor(input: {
    classification: ModelProviderFailureClassV1;
    reason: unknown;
    retryAfterMs?: number;
  }) {
    const reason = boundedModelProviderReasonV1(input.reason);
    super(reason);
    this.name = "ModelProviderFailureError";
    this.classification = input.classification;
    this.providerReason = reason;
    if (
      input.retryAfterMs !== undefined &&
      Number.isSafeInteger(input.retryAfterMs) &&
      input.retryAfterMs >= 0
    ) {
      this.retryAfterMs = input.retryAfterMs;
    }
  }
}

/**
 * What a person is told when a model call was dispatched and its outcome is
 * unknown: the answer was lost rather than refused.
 *
 * It is user-facing copy in the register the deadlines use, because the
 * alternative is the generic "couldn't reply", which says nothing about why
 * sending the same message again is the right next move.
 */
export const MODEL_OUTCOME_UNCERTAIN_REASON_V1 =
  "This Bot's model request went out and its answer was lost, so the reply was stopped rather than sent twice. Try sending your message again.";

/**
 * A model call that reached the provider and whose outcome is unknown: the
 * stream was cut mid-answer, the provider accepted the request and never
 * answered, or the worker carrying it died.
 *
 * It is deliberately not a `ModelProviderFailureError`: that class is a
 * definitive result, and the kernel and Billing both treat it as a call that
 * never happened. This one is the opposite — whether it billed is exactly
 * what is unknown — so the loop settles the Turn with the estimate recorded
 * and, above all, does not dispatch it again. Re-dispatching is not the
 * provider's decision to make: one request id is one upstream call.
 */
export class ModelOutcomeUncertainErrorV1 extends Error {
  constructor(reason?: unknown) {
    super(
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1)
        : MODEL_OUTCOME_UNCERTAIN_REASON_V1,
    );
    this.name = "ModelOutcomeUncertainError";
  }
}

/** @deprecated Providers should raise a classified failure instead. */
export class LlmEffectNotStartedError extends ModelProviderFailureError {
  constructor(message: string) {
    super({ classification: "unknown", reason: message });
    this.name = "LlmEffectNotStartedError";
  }
}

/**
 * What a person is told when a model request produced nothing at all.
 *
 * The same register as the Turn deadline copy: what happened, and what to do
 * about it. The phase, the provider and the millisecond count are diagnostics
 * and belong in the log, not on a person's screen.
 */
export const MODEL_FIRST_BYTE_DEADLINE_REASON_V1 =
  "The model did not start replying within 2 minutes and the request was stopped. Try sending it again.";

/** What a person is told when a reply started and then went silent. */
export const MODEL_IDLE_DEADLINE_REASON_V1 =
  "The model stopped part-way through its reply and went quiet for a minute, so the request was stopped. Try sending it again.";

/**
 * Time allowed from sending a model request to its first stream event.
 *
 * Two minutes to say anything at all is generous for a chat completion and
 * still far inside the fifteen-minute Turn deadline, which before this was the
 * only bound anywhere and far too long to read as an answer.
 */
export const MODEL_FIRST_BYTE_DEADLINE_MS_V1 = 120_000;

/**
 * Time allowed between two stream events once the answer has started.
 *
 * Shorter than the first-byte allowance on purpose: a stream that has already
 * produced a chunk has proved the model is generating, so a minute of silence
 * after that is a dead socket rather than a slow start.
 */
export const MODEL_IDLE_DEADLINE_MS_V1 = 60_000;

/**
 * A model request that ran out of time.
 *
 * Two deadlines, because they fail differently. `first-byte` is a provider that
 * accepted the request and said nothing: the request may well be running, so
 * the outcome is uncertain and the run settles on that. `idle` is a stream that
 * started and then stopped mid-answer, which is the same uncertainty arriving
 * later, with words already on screen.
 *
 * Either is a real answer where before there was none: a Turn with no deadline
 * anywhere hung for seventeen minutes showing nothing at all. The message is
 * the copy a person reads, so it says nothing the caller could vary.
 */
export class ModelRequestDeadlineError extends Error {
  constructor(
    readonly phase: "first-byte" | "idle",
    readonly milliseconds: number,
  ) {
    super(
      phase === "first-byte"
        ? MODEL_FIRST_BYTE_DEADLINE_REASON_V1
        : MODEL_IDLE_DEADLINE_REASON_V1,
    );
    this.name = "ModelRequestDeadlineError";
  }
}

/** Deadlines a provider applies to one model request. */
export interface ModelRequestDeadlinesV1 {
  /** Time allowed from sending the request to the first stream event. */
  firstByteMs: number;
  /** Time allowed between two stream events once the answer has started. */
  idleMs: number;
}

/** The defaults every provider gets unless its Package names others. */
export const MODEL_REQUEST_DEADLINES_V1: ModelRequestDeadlinesV1 = {
  firstByteMs: MODEL_FIRST_BYTE_DEADLINE_MS_V1,
  idleMs: MODEL_IDLE_DEADLINE_MS_V1,
};

export interface LlmProvider {
  id: string;
  /** Legacy/test adapters that omit this are treated as supporting nothing. */
  supports?: ModelProviderSupportsV1;
  /**
   * The model this provider offers for conversation summaries, and the
   * Connection authority a summary request carries. A Bot's summaries run on
   * it whatever model the Bot itself is on.
   */
  summaryModel?: { model: string; modelBinding: ModelBindingSnapshot };
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
}

/** The kernel-declared model invocation interface. Implemented by a Package. */
export interface ModelInvocation {
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  structured<T>(
    request: NormalizedModelRequest,
    format: Omit<JsonSchemaResponseFormatV1, "type">,
    signal: AbortSignal,
  ): Promise<StructuredModelResultV1<T>>;
}

/** Provider Packages register themselves through this surface. */
export interface ModelProviderRegistration {
  register(provider: LlmProvider): () => void;
  get(providerId: string): LlmProvider | undefined;
  list(): LlmProvider[];
}
