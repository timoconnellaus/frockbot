// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
import type { LlmStreamEvent, NormalizedModelRequest } from "./types.js";

export interface DurableModelEffect {
  providerEffectId: string;
  request: NormalizedModelRequest;
}

export class LlmEffectNotStartedError extends Error {
  constructor(message: string) {
    super(message);
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

export type LlmReconciliationOutcome =
  | {
      status: "recovered";
      events: readonly LlmStreamEvent[];
    }
  | {
      status: "unavailable";
      reason: string;
    };

export interface LlmReconciliationCapability {
  retrieve(
    effect: DurableModelEffect,
    signal: AbortSignal,
  ): Promise<LlmReconciliationOutcome>;
}

export interface LlmProvider {
  id: string;
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  reconciliation?: LlmReconciliationCapability;
}

/** The kernel-declared model invocation interface. Implemented by a Package. */
export interface ModelInvocation {
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  reconcile(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): Promise<LlmReconciliationOutcome>;
}

/** Provider Packages register themselves through this surface. */
export interface ModelProviderRegistration {
  register(provider: LlmProvider): () => void;
  get(providerId: string): LlmProvider | undefined;
  list(): LlmProvider[];
}

declare module "cordis" {
  interface Context {
    llm: ModelInvocation & ModelProviderRegistration;
  }

  interface Events {
    "llm/stream": (
      request: NormalizedModelRequest,
      signal: AbortSignal,
      next: () => AsyncIterable<LlmStreamEvent>,
    ) => AsyncIterable<LlmStreamEvent>;
  }
}
