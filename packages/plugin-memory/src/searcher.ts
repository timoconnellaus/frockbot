import { hashMemoryContent } from "./chunker.js";
import type { MemoryDocumentStore } from "./storage.js";
import type {
  EmbedMemory,
  MemoryScope,
  MemorySearchResult,
  MemoryTier,
  MemoryVectorIndex,
  MemoryVectorMatch,
} from "./types.js";

const SNIPPET_MAX_CHARS = 700;
const KEYWORD_CONTEXT_LINES = 5;

function extractLines(
  text: string,
  startLine: number,
  endLine: number,
): string {
  const lines = text.split("\n");
  return lines
    .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
    .join("\n");
}

function truncate(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const slice = text.slice(0, SNIPPET_MAX_CHARS);
  const boundary = slice.lastIndexOf(" ");
  return `${boundary > 0 ? slice.slice(0, boundary) : slice}…`;
}

function matchMetadata(match: MemoryVectorMatch): {
  path: string;
  startLine: number;
  endLine: number;
  documentHash: string;
} | null {
  const path = match.metadata?.path;
  const startLine = match.metadata?.startLine;
  const endLine = match.metadata?.endLine;
  const documentHash = match.metadata?.documentHash;
  return typeof path === "string" &&
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    typeof documentHash === "string"
    ? { path, startLine, endLine, documentHash }
    : null;
}

async function vectorSearch(
  scope: MemoryScope,
  queryVector: number[],
  maxResults: number,
  vectorize: MemoryVectorIndex,
  storage: MemoryDocumentStore,
): Promise<MemorySearchResult[]> {
  const response = await vectorize.query(queryVector, {
    topK: Math.min(maxResults * 3, 20),
    namespace: scope.vectorNamespace,
    returnMetadata: "all",
  });
  const bestByPath = new Map<string, MemoryVectorMatch>();
  for (const match of response.matches) {
    const metadata = matchMetadata(match);
    if (!metadata) continue;
    const current = bestByPath.get(metadata.path);
    if (!current || (match.score ?? 0) > (current.score ?? 0)) {
      bestByPath.set(metadata.path, match);
    }
  }
  const matches = [...bestByPath.values()]
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, maxResults);
  const hydrated = await Promise.all(
    matches.map(async (match): Promise<MemorySearchResult | null> => {
      const metadata = matchMetadata(match);
      if (!metadata) return null;
      const content = await storage.readContent(scope, metadata.path);
      if (
        content === null ||
        (await hashMemoryContent(content)) !== metadata.documentHash
      ) {
        return null;
      }
      return {
        path: metadata.path,
        tier: scope.tier,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        snippet: truncate(
          extractLines(content, metadata.startLine, metadata.endLine),
        ),
        score: match.score,
      };
    }),
  );
  return hydrated.filter(
    (result): result is MemorySearchResult => result !== null,
  );
}

async function keywordSearch(
  scope: MemoryScope,
  query: string,
  maxResults: number,
  storage: MemoryDocumentStore,
): Promise<MemorySearchResult[]> {
  const needle = query.toLowerCase();
  const results: MemorySearchResult[] = [];
  for (const path of await storage.listPaths(scope)) {
    if (results.length >= maxResults) break;
    const content = await storage.readContent(scope, path);
    if (content === null) continue;
    const lines = content.split("\n");
    const visited: Array<[number, number]> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!(lines[index] ?? "").toLowerCase().includes(needle)) continue;
      const start = Math.max(0, index - KEYWORD_CONTEXT_LINES);
      const end = Math.min(lines.length - 1, index + KEYWORD_CONTEXT_LINES);
      if (visited.some(([from, to]) => start <= to && end >= from)) continue;
      visited.push([start, end]);
      results.push({
        path,
        tier: scope.tier,
        startLine: start + 1,
        endLine: end + 1,
        snippet: truncate(lines.slice(start, end + 1).join("\n")),
      });
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

export interface SearchMemoryOptions {
  scopes: MemoryScope[];
  query: string;
  maxResults: number;
  embed: EmbedMemory;
  vectorize: MemoryVectorIndex;
  storage: MemoryDocumentStore;
}

function preferAgentOnPathClashes(
  results: MemorySearchResult[],
): MemorySearchResult[] {
  const byPath = new Map<string, MemorySearchResult>();
  for (const result of results) {
    const current = byPath.get(result.path);
    if (!current || (current.tier === "global" && result.tier === "agent")) {
      byPath.set(result.path, result);
      continue;
    }
    if (
      current.tier === result.tier &&
      (result.score ?? -Infinity) > (current.score ?? -Infinity)
    ) {
      byPath.set(result.path, result);
    }
  }
  return [...byPath.values()];
}

async function replaceGlobalClashesWithAgentCopies(
  results: MemorySearchResult[],
  scopes: MemoryScope[],
  storage: MemoryDocumentStore,
): Promise<MemorySearchResult[]> {
  const agentScope = scopes.find((scope) => scope.tier === "agent");
  if (!agentScope) return results;
  return Promise.all(
    results.map(async (result): Promise<MemorySearchResult> => {
      if (result.tier !== "global") return result;
      const content = await storage.readContent(agentScope, result.path);
      if (content === null) return result;
      return {
        path: result.path,
        tier: "agent",
        startLine: 1,
        endLine: content.split("\n").length,
        snippet: truncate(content),
      };
    }),
  );
}

export async function searchMemory(
  options: SearchMemoryOptions,
): Promise<MemorySearchResult[]> {
  const { scopes, maxResults, embed, vectorize, storage } = options;
  const query = options.query.trim();
  if (!query) return [];
  let queryVector: number[] | undefined;
  try {
    queryVector = (await embed([query]))[0];
  } catch (error) {
    console.error(
      "[memory] query embedding failed; using keyword search",
      error,
    );
  }

  const perTierLimit = Math.max(1, maxResults);
  const collected: MemorySearchResult[] = [];
  for (const scope of scopes) {
    let vectorResults: MemorySearchResult[] = [];
    if (queryVector) {
      try {
        vectorResults = await vectorSearch(
          scope,
          queryVector,
          perTierLimit,
          vectorize,
          storage,
        );
      } catch (error) {
        console.error(
          `[memory] ${scope.tier} vector search failed; using canonical R2 search`,
          error,
        );
      }
    }
    const keywordResults = await keywordSearch(
      scope,
      query,
      perTierLimit,
      storage,
    );
    collected.push(...vectorResults, ...keywordResults);
  }

  const selected = preferAgentOnPathClashes(collected)
    .sort((left, right) => {
      if (left.score === undefined && right.score !== undefined) return 1;
      if (left.score !== undefined && right.score === undefined) return -1;
      if (left.score !== undefined && right.score !== undefined) {
        const scoreDifference = right.score - left.score;
        if (scoreDifference !== 0) return scoreDifference;
      }
      if (left.tier !== right.tier) return left.tier === "agent" ? -1 : 1;
      return left.path.localeCompare(right.path);
    })
    .slice(0, maxResults);
  return replaceGlobalClashesWithAgentCopies(selected, scopes, storage);
}

export function formatMemoryResults(results: MemorySearchResult[]): string {
  if (results.length === 0) return "No memory matches.";
  return results
    .map((result, index) => {
      const score =
        result.score === undefined
          ? ""
          : ` (score: ${result.score.toFixed(3)})`;
      return `[${index + 1}] ${result.tier}:${result.path}:${result.startLine}-${result.endLine}${score}\n${result.snippet}`;
    })
    .join("\n\n---\n\n");
}

export function scopesForTier(
  scopes: Record<MemoryTier, MemoryScope>,
  tier?: MemoryTier,
): MemoryScope[] {
  return tier ? [scopes[tier]] : [scopes.agent, scopes.global];
}
