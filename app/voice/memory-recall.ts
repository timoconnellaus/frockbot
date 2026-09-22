// Voice recall against the canonical engine.
//
// Opening loads the same prepared core as chat. Lookups are blocking Gemini
// function calls. A finalized transcript may prefetch into an attempt-scoped
// cache; the function handler consumes that cache or queries itself.
//
// Automatic recall before the model starts answering is not provided. Gemini
// Live can begin a reply before the transcript callback runs, and this module
// does not invent a turn-control gate or splice context into the socket.

export const VOICE_AUTOMATIC_PREANSWER_RECALL_V1 = "unsupported" as const;

export interface VoiceMemoryPrefetchEntryV1<T> {
  attemptId: string;
  query: string;
  result: Promise<T>;
}

export class VoiceMemoryPrefetchCacheV1<T> {
  #current: VoiceMemoryPrefetchEntryV1<T> | undefined;

  start(attemptId: string, query: string, run: () => Promise<T>): void {
    this.#current = { attemptId, query, result: run() };
  }

  /** The result for this attempt and query, or undefined when it does not match. */
  take(attemptId: string, query: string): Promise<T> | undefined {
    const current = this.#current;
    if (!current || current.attemptId !== attemptId) return undefined;
    if (current.query.trim() !== query.trim()) return undefined;
    this.#current = undefined;
    return current.result;
  }

  cancel(attemptId: string): void {
    if (this.#current?.attemptId === attemptId) this.#current = undefined;
  }

  replace(attemptId: string): void {
    if (this.#current && this.#current.attemptId !== attemptId) {
      this.#current = undefined;
    }
  }
}

/** Injected core or membership no longer matches. Resume must not keep it. */
export function voiceMemoryRequiresReopenV1(input: {
  injectedEpoch: string;
  currentEpoch: string;
  injectedMembership: string;
  currentMembership: string;
}): boolean {
  return (
    input.injectedEpoch !== input.currentEpoch ||
    input.injectedMembership !== input.currentMembership
  );
}
