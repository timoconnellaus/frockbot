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
