// Searching Memory over the derived index.
//
// The index is derived and rebuildable, so it is never authoritative about a
// fact: a hit names a document and a line range, and the caller reads the
// bytes back out of the Workspace before showing them. That is the same rule
// the rest of the Package follows — the files are the Memory, everything else
// is a way of finding a part of them.
//
// Precedence here is the Memory precedence: own (`bot`) before `project`
// before `user`, "the most specific wins", applied after scoring so a strong
// shared hit still ranks above a weak own one within the same document.
import type { MemoryScopeNameV1 } from "@frockbot/kernel-contracts";
import {
  memoryVectorNamespaceV1,
  type MemoryIndexChunkV1,
  type MemoryIndexV1,
} from "./indexer.js";
import type {
  EmbedMemory,
  MemorySearchResult,
  MemoryVectorIndex,
} from "./types.js";

const SNIPPET_MAX_CHARS = 700;

const SCOPE_ORDER: Record<MemoryScopeNameV1, number> = {
  bot: 0,
  project: 1,
  user: 2,
};

function truncate(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const slice = text.slice(0, SNIPPET_MAX_CHARS);
  const boundary = slice.lastIndexOf(" ");
  return `${boundary > 0 ? slice.slice(0, boundary) : slice}…`;
}

function resultOf(
  chunk: MemoryIndexChunkV1,
  score?: number,
): MemorySearchResult {
  return {
    scope: chunk.scope,
    projectId: chunk.projectId,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    snippet: truncate(chunk.content),
    ...(score === undefined ? {} : { score }),
  };
}

function lexicalScore(content: string, terms: string[]): number {
  const haystack = content.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return terms.length === 0 ? 0 : hits / terms.length;
}

export interface SearchMemoryOptionsV1 {
  index: MemoryIndexV1;
  query: string;
  maxResults: number;
  scope?: MemoryScopeNameV1;
  embed?: EmbedMemory;
  vectorize?: MemoryVectorIndex;
}

/**
 * Vector search when an embedder and a vector index are configured, lexical
 * search otherwise, and lexical search as the fallback when the embedder
 * fails. A Memory search must not fail a Turn because a model binding is
 * briefly unavailable.
 */
export async function searchMemoryV1(
  options: SearchMemoryOptionsV1,
): Promise<MemorySearchResult[]> {
  const query = options.query.trim();
  if (!query) return [];
  const candidates = options.index.chunks.filter(
    (chunk) => options.scope === undefined || chunk.scope === options.scope,
  );
  if (candidates.length === 0) return [];

  const scored = new Map<MemoryIndexChunkV1, number>();
  if (options.embed && options.vectorize) {
    try {
      const [vector] = await options.embed([query]);
      if (vector) {
        const namespaces = new Set(candidates.map(memoryVectorNamespaceV1));
        const byHash = new Map(
          candidates.map((chunk) => [chunk.hash, chunk] as const),
        );
        for (const namespace of namespaces) {
          const response = await options.vectorize.query(vector, {
            topK: Math.min(options.maxResults * 3, 20),
            namespace,
            returnMetadata: "all",
          });
          for (const match of response.matches) {
            const hash = match.metadata?.hash;
            const chunk =
              typeof hash === "string" ? byHash.get(hash) : undefined;
            if (!chunk) continue;
            scored.set(
              chunk,
              Math.max(scored.get(chunk) ?? 0, match.score ?? 0),
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "[memory] vector search failed; using lexical search",
        error,
      );
    }
  }

  if (scored.size === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 1);
    for (const chunk of candidates) {
      const score = lexicalScore(chunk.content, terms);
      if (score > 0) scored.set(chunk, score);
    }
  }

  return [...scored.entries()]
    .sort(([leftChunk, leftScore], [rightChunk, rightScore]) => {
      if (rightScore !== leftScore) return rightScore - leftScore;
      const order =
        SCOPE_ORDER[leftChunk.scope] - SCOPE_ORDER[rightChunk.scope];
      if (order !== 0) return order;
      return leftChunk.path.localeCompare(rightChunk.path);
    })
    .slice(0, options.maxResults)
    .map(([chunk, score]) => resultOf(chunk, score));
}

/** The compact rendering a tool result carries. */
export function formatMemoryResultsV1(results: MemorySearchResult[]): string {
  if (results.length === 0) return "No memory matches.";
  return results
    .map((result, index) => {
      const where = result.projectId
        ? `${result.scope}/${result.projectId}`
        : result.scope;
      const score =
        result.score === undefined
          ? ""
          : ` (score: ${result.score.toFixed(3)})`;
      return `[${index + 1}] ${where}:${result.path}:${result.startLine}-${result.endLine}${score}\n${result.snippet}`;
    })
    .join("\n\n---\n\n");
}
