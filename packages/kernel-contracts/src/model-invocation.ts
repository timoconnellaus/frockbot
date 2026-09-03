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

export type LlmReconciliationOutcome =
  | {
      status: "recovered";
      events: readonly LlmStreamEvent[];
    }
  | {
      /**
       * The effect may still exist at the provider but cannot be read right
       * now. The run parks and can be reconciled again later.
       */
      status: "unavailable";
      reason: string;
    }
  | {
      /**
       * The provider keeps no durable copy of this effect, so no later attempt
       * can do better. The run settles as a failure — with whatever text was
       * already journaled preserved — rather than parking forever on a
       * retrieval that will never succeed.
       */
      status: "not-retrievable";
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
