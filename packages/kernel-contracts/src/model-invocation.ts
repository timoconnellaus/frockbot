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
 * A model request that ran out of time.
 *
 * Two deadlines, because they fail differently. `first-byte` is a provider that
 * accepted the request and said nothing: the request may well be running, so
 * the outcome is uncertain and the run settles on that. `idle` is a stream that
 * started and then stopped mid-answer, which is the same uncertainty arriving
 * later, with words already on screen.
 *
 * Either is a real answer where before there was none: a Turn with no deadline
 * anywhere hung for seventeen minutes showing nothing at all.
 */
export class ModelRequestDeadlineError extends Error {
  constructor(
    readonly phase: "first-byte" | "idle",
    readonly milliseconds: number,
  ) {
    super(
      phase === "first-byte"
        ? `Model request produced nothing within ${Math.round(milliseconds / 1000)}s`
        : `Model response stalled for ${Math.round(milliseconds / 1000)}s`,
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

/**
 * The defaults every provider gets unless its Package names others.
 *
 * Two minutes to say anything at all is generous for a chat completion and
 * still an order of magnitude inside the wall-clock a person will wait; the
 * same allowance between chunks tolerates a slow tool-call assembly without
 * tolerating a dead socket.
 */
export const MODEL_REQUEST_DEADLINES_V1: ModelRequestDeadlinesV1 = {
  firstByteMs: 120_000,
  idleMs: 120_000,
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
