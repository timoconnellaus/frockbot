import { type Context, Service } from "cordis";
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

declare module "cordis" {
  interface Context {
    llm: LlmRegistry;
  }

  interface Events {
    "llm/stream": (
      request: NormalizedModelRequest,
      signal: AbortSignal,
      next: () => AsyncIterable<LlmStreamEvent>,
    ) => AsyncIterable<LlmStreamEvent>;
  }
}

export class LlmRegistry extends Service {
  private providers = new Map<string, LlmProvider>();

  constructor(ctx: Context) {
    super(ctx, "llm");
  }

  register(provider: LlmProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`LLM provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return () => {
      if (this.providers.get(provider.id) === provider) {
        this.providers.delete(provider.id);
      }
    };
  }

  get(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): LlmProvider[] {
    return [...this.providers.values()];
  }

  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const provider = this.providers.get(request.provider);
    if (!provider)
      throw new LlmEffectNotStartedError(
        `LLM provider "${request.provider}" is unavailable`,
      );
    return this.ctx.waterfall("llm/stream", request, signal, () =>
      provider.stream(request, signal),
    );
  }

  async reconcile(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): Promise<LlmReconciliationOutcome> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      return {
        status: "unavailable",
        reason: `LLM provider "${request.provider}" is unavailable`,
      };
    }
    if (!provider.reconciliation) {
      return {
        status: "unavailable",
        reason: `LLM provider "${request.provider}" does not support provider-bound retrieval`,
      };
    }
    try {
      return await provider.reconciliation.retrieve(
        { providerEffectId: request.requestId, request },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "Provider-bound retrieval failed",
      };
    }
  }
}
