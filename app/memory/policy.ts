// Retrieval budgets for one Memory request.
//
// One policy covers every scope and channel. A fresh limit per Bot, Group
// or model step would let a wide account multiply the cap. Numbers are the
// initial engineering limits from the Memory packet, not measured latency.

import { memoryTokenEstimateV1 } from "./records.js";

export const MEMORY_POLICY_V1 = {
  preparedCoreTokens: 1_024,
  activeRecallTokens: 2_048,
  totalContributionTokens: 3_072,
  candidatesPerChannel: 20,
  hydratedCandidates: 80,
  graphHop: 1,
  graphExpansionRecords: 32,
  concurrentRetrievalCalls: 4,
  automaticInitialSearches: 1,
  automaticAdditionalSearches: 2,
  automaticDeadlineMs: 750,
  explicitDeadlineMs: 3_000,
  rrfK: 60,
  /** UTF-8 bytes of one query. Longer text is clipped, not rejected. */
  maxQueryBytes: 1_024,
  /**
   * Scopes searched in one request. `hydratedCandidates / candidatesPerChannel`
   * so one full channel page per scope still fits the hydrate cap.
   */
  maxScopesPerRequest: 4,
} as const;

export type MemoryPolicyV1 = typeof MEMORY_POLICY_V1;

export type MemoryRecallChannelNameV1 = "fts" | "semantic" | "time";

export type MemoryChannelStatusV1 =
  "complete" | "partial" | "unavailable" | "skipped";

/**
 * Conservative token estimate. No provider tokenizer is mounted on this
 * path, so the count is UTF-8 bytes plus the wrapper allowance already in
 * `memoryTokenEstimateV1`. Callers label it as an estimate.
 */
export function memoryPolicyTokensV1(text: string): number {
  return memoryTokenEstimateV1(text);
}

export function clipMemoryQueryV1(query: string): {
  query: string;
  clipped: boolean;
} {
  const trimmed = query.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength <= MEMORY_POLICY_V1.maxQueryBytes) {
    return { query: trimmed, clipped: false };
  }
  let kept = trimmed;
  while (
    kept.length > 0 &&
    new TextEncoder().encode(kept).byteLength > MEMORY_POLICY_V1.maxQueryBytes
  ) {
    kept = kept.slice(0, -1);
  }
  return { query: kept.trim(), clipped: true };
}

/** Empty and short control utterances. A greeting with content is not skipped. */
export function isControlOnlyMemoryInputV1(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length > 64) return false;
  return /^(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|yep|nope|stop|bye|goodbye)[.!?\s]*$/i.test(
    trimmed,
  );
}

export function memoryDeadlineMsV1(
  effort: "automatic" | "explicit" | undefined,
): number {
  return effort === "automatic"
    ? MEMORY_POLICY_V1.automaticDeadlineMs
    : MEMORY_POLICY_V1.explicitDeadlineMs;
}

export interface MemoryScopePageV1<T> {
  selected: T[];
  omitted: T[];
}

/**
 * Explicit scope first, then a stable fair page. The rest is an omission
 * the model can name directly; it is not searched and filtered afterward.
 */
export function suballocateMemoryScopesV1<T>(
  scopes: readonly T[],
  options: {
    limit: number;
    key: (scope: T) => string;
    explicitKey?: string;
  },
): MemoryScopePageV1<T> {
  if (scopes.length <= options.limit) {
    return { selected: [...scopes], omitted: [] };
  }
  const explicit = options.explicitKey
    ? scopes.find((scope) => options.key(scope) === options.explicitKey)
    : undefined;
  const rest = scopes
    .filter((scope) => scope !== explicit)
    .slice()
    .sort((left, right) => options.key(left).localeCompare(options.key(right)));
  const selected: T[] = [];
  if (explicit !== undefined) selected.push(explicit);
  for (const scope of rest) {
    if (selected.length >= options.limit) break;
    selected.push(scope);
  }
  const chosen = new Set<T>(selected);
  return {
    selected,
    omitted: scopes.filter((scope) => !chosen.has(scope)),
  };
}

export function clipMemoryItemsToTokensV1<T>(
  items: readonly T[],
  budget: number,
  tokens: (item: T) => number,
): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = tokens(item);
    if (kept.length > 0 && used + cost > budget) {
      return { kept, omitted: items.length - kept.length };
    }
    if (kept.length === 0 && cost > budget) {
      return { kept: [], omitted: items.length };
    }
    kept.push(item);
    used += cost;
  }
  return { kept, omitted: 0 };
}
