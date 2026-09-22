// Semantic channel over the derived vector index.
//
// The query names one authorized scope as the namespace before top-K.
// Hits are hydrated from canonical rows afterward; a vector id is not a fact.

import type { EmbedMemory, MemoryVectorIndex } from "./types.js";

export interface MemorySemanticSearchV1 {
  search(
    scopeKey: string,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Array<{ itemId: string; rank: number }>>;
}

export function createVectorMemorySearchV1(
  vectors: MemoryVectorIndex,
  embed: EmbedMemory,
): MemorySemanticSearchV1 {
  return {
    async search(scopeKey, query, limit, signal) {
      if (signal.aborted) throw new Error("semantic search was cancelled");
      const vectorsForQuery = await embed([query]);
      const values = vectorsForQuery[0];
      if (!values || signal.aborted) return [];
      const matches = await vectors.query(values, {
        topK: limit,
        namespace: scopeKey,
        returnMetadata: "all",
      });
      const ranked: Array<{ itemId: string; rank: number }> = [];
      for (const match of matches.matches) {
        const itemId = match.metadata?.itemId;
        if (typeof itemId !== "string" || itemId.length === 0) continue;
        const scope = match.metadata?.scopeKey;
        if (typeof scope === "string" && scope !== scopeKey) continue;
        ranked.push({ itemId, rank: ranked.length + 1 });
        if (ranked.length >= limit) break;
      }
      return ranked;
    },
  };
}
