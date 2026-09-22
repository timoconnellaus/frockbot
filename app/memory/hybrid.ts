// Hybrid recall: lexical, semantic and time channels fused by reciprocal
// rank, then one hop of relationship neighbors. No second model reranks.

import {
  MEMORY_POLICY_V1,
  clipMemoryItemsToTokensV1,
  isControlOnlyMemoryInputV1,
  memoryPolicyTokensV1,
  type MemoryChannelStatusV1,
  type MemoryRecallChannelNameV1,
} from "./policy.js";

export interface RankedMemoryIdV1 {
  scopeKey: string;
  itemId: string;
  rank: number;
}

export interface MemoryChannelCandidatesV1 {
  channel: MemoryRecallChannelNameV1;
  status: MemoryChannelStatusV1;
  ranked: RankedMemoryIdV1[];
}

export interface FusionMemoryItemV1 {
  scopeKey: string;
  itemId: string;
  kind: "fact" | "experience" | "observation";
  text: string;
  leaves: ReadonlyArray<{ itemId: string }>;
  contradicts: readonly string[];
}

export interface MemoryNeighborV1 {
  scopeKey: string;
  itemId: string;
  relation: string;
}

const itemKey = (scopeKey: string, itemId: string): string =>
  `${scopeKey}\u0000${itemId}`;

export function reciprocalRankFusionV1(
  channels: readonly MemoryChannelCandidatesV1[],
): Array<{ scopeKey: string; itemId: string; score: number }> {
  const scores = new Map<
    string,
    { scopeKey: string; itemId: string; score: number }
  >();
  for (const channel of channels) {
    if (channel.status === "skipped" || channel.status === "unavailable") {
      continue;
    }
    for (const hit of channel.ranked) {
      const key = itemKey(hit.scopeKey, hit.itemId);
      const score = 1 / (MEMORY_POLICY_V1.rrfK + hit.rank);
      const existing = scores.get(key);
      if (existing) existing.score += score;
      else
        scores.set(key, { scopeKey: hit.scopeKey, itemId: hit.itemId, score });
    }
  }
  return [...scores.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const scope = left.scopeKey.localeCompare(right.scopeKey);
    if (scope !== 0) return scope;
    return left.itemId.localeCompare(right.itemId);
  });
}

/**
 * Round-robin across channels so one channel cannot consume the hydrate cap
 * before the others are seen. Order within a channel is its rank.
 */
export function selectHydrationIdsV1(
  channels: readonly MemoryChannelCandidatesV1[],
  cap: number,
): RankedMemoryIdV1[] {
  const lists = channels.map((channel) =>
    [...channel.ranked].sort((left, right) => left.rank - right.rank),
  );
  const chosen: RankedMemoryIdV1[] = [];
  const seen = new Set<string>();
  let index = 0;
  let progressed = true;
  while (chosen.length < cap && progressed) {
    progressed = false;
    for (const list of lists) {
      const hit = list[index];
      if (!hit) continue;
      progressed = true;
      const key = itemKey(hit.scopeKey, hit.itemId);
      if (!seen.has(key)) {
        seen.add(key);
        chosen.push(hit);
        if (chosen.length >= cap) break;
      }
    }
    index += 1;
  }
  return chosen;
}

export function renumberChannelRanksV1(
  channels: readonly MemoryChannelCandidatesV1[],
  kept: ReadonlySet<string>,
): MemoryChannelCandidatesV1[] {
  return channels.map((channel) => {
    const ranked = channel.ranked
      .filter((hit) => kept.has(itemKey(hit.scopeKey, hit.itemId)))
      .sort((left, right) => left.rank - right.rank)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
    return { ...channel, ranked };
  });
}

/**
 * A valid observation replaces the leaves it fully covers when it is the
 * shorter text. A leaf that contradicts another active hit stays visible.
 */
export function preferCoveringObservationsV1(
  ordered: readonly FusionMemoryItemV1[],
): FusionMemoryItemV1[] {
  const byKey = new Map(
    ordered.map((item) => [itemKey(item.scopeKey, item.itemId), item]),
  );
  const drop = new Set<string>();
  for (const item of ordered) {
    if (item.kind !== "observation" || item.leaves.length === 0) continue;
    const leaves = item.leaves.flatMap((leaf) => {
      const found = byKey.get(itemKey(item.scopeKey, leaf.itemId));
      return found ? [found] : [];
    });
    if (leaves.length !== item.leaves.length) continue;
    const leafTokens = leaves.reduce(
      (sum, leaf) => sum + memoryPolicyTokensV1(leaf.text),
      0,
    );
    if (memoryPolicyTokensV1(item.text) > leafTokens) continue;
    for (const leaf of leaves) {
      const contradicted = ordered.some(
        (other) =>
          other.itemId !== leaf.itemId &&
          (other.contradicts.includes(leaf.itemId) ||
            leaf.contradicts.includes(other.itemId)),
      );
      if (!contradicted) drop.add(itemKey(leaf.scopeKey, leaf.itemId));
    }
  }
  return ordered.filter(
    (item) => !drop.has(itemKey(item.scopeKey, item.itemId)),
  );
}

export function expandMemoryNeighborsV1(
  seeds: readonly FusionMemoryItemV1[],
  neighbors: readonly MemoryNeighborV1[],
  hydrate: (scopeKey: string, itemId: string) => FusionMemoryItemV1 | undefined,
): FusionMemoryItemV1[] {
  const seen = new Set(
    seeds.map((item) => itemKey(item.scopeKey, item.itemId)),
  );
  const extra: FusionMemoryItemV1[] = [];
  for (const neighbor of neighbors) {
    if (extra.length >= MEMORY_POLICY_V1.graphExpansionRecords) break;
    const key = itemKey(neighbor.scopeKey, neighbor.itemId);
    if (seen.has(key)) continue;
    const item = hydrate(neighbor.scopeKey, neighbor.itemId);
    if (!item) continue;
    seen.add(key);
    extra.push(item);
  }
  return extra;
}

export interface FusedMemoryRecallV1 {
  items: FusionMemoryItemV1[];
  omitted: number;
  tokensEstimated: number;
}

export function fuseMemoryRecallV1(input: {
  channels: readonly MemoryChannelCandidatesV1[];
  items: ReadonlyMap<string, FusionMemoryItemV1>;
  neighbors: readonly MemoryNeighborV1[];
  hydrateNeighbor: (
    scopeKey: string,
    itemId: string,
  ) => FusionMemoryItemV1 | undefined;
  tokenBudget: number;
}): FusedMemoryRecallV1 {
  const hydratedIds = selectHydrationIdsV1(
    input.channels,
    MEMORY_POLICY_V1.hydratedCandidates,
  );
  const kept = new Set(
    hydratedIds
      .map((hit) => itemKey(hit.scopeKey, hit.itemId))
      .filter((key) => input.items.has(key)),
  );
  const fused = reciprocalRankFusionV1(
    renumberChannelRanksV1(input.channels, kept),
  );
  const seeds = fused.flatMap((hit) => {
    const item = input.items.get(itemKey(hit.scopeKey, hit.itemId));
    return item ? [item] : [];
  });
  const seedIds = new Set(seeds.map((item) => item.itemId));
  const neighborItems = expandMemoryNeighborsV1(
    seeds,
    input.neighbors.filter(
      (neighbor) => seedIds.has(neighbor.itemId) === false,
    ),
    input.hydrateNeighbor,
  );
  // Neighbors are keyed by the seed they came from; the caller passes the
  // neighbor's own id. Filter to those whose *from* side is a seed by
  // trusting the caller list, which is already seed-scoped.
  const expanded = preferCoveringObservationsV1([...seeds, ...neighborItems]);
  const clipped = clipMemoryItemsToTokensV1(
    expanded,
    input.tokenBudget,
    (item) => memoryPolicyTokensV1(item.text),
  );
  const tokensEstimated = clipped.kept.reduce(
    (sum, item) => sum + memoryPolicyTokensV1(item.text),
    0,
  );
  return {
    items: clipped.kept,
    omitted: clipped.omitted,
    tokensEstimated,
  };
}

export function explicitDatesInQueryV1(query: string): {
  occurredFrom?: string;
  occurredTo?: string;
} {
  const dates = [...query.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map(
    (match) => match[1]!,
  );
  if (dates.length === 0) return {};
  const sorted = [...dates].sort();
  return {
    occurredFrom: `${sorted[0]}T00:00:00.000Z`,
    occurredTo: `${sorted[sorted.length - 1]}T23:59:59.999Z`,
  };
}

export function memoryRecallCacheKeyV1(input: {
  query: string;
  scopeKeys: readonly string[];
  membershipRevision: string;
  epochs: readonly string[];
  embeddingPolicy: string;
  filters: string;
}): string {
  return [
    input.query.trim().toLowerCase().replace(/\s+/g, " "),
    [...input.scopeKeys].sort().join(","),
    input.membershipRevision,
    [...input.epochs].sort().join(","),
    input.embeddingPolicy,
    input.filters,
  ].join("\u0001");
}

export interface SettledChannelV1<T> {
  status: "complete" | "partial";
  value?: T;
}

/**
 * Runs channel tasks with a shared concurrency cap. At the deadline, finished
 * tasks are kept and the rest are reported partial. The caller aborts them.
 */
export async function settleMemoryChannelsV1<T>(
  tasks: ReadonlyArray<{
    run: (signal: AbortSignal) => Promise<T>;
  }>,
  options: {
    concurrency: number;
    deadlineMs: number;
    now?: () => number;
  },
): Promise<Array<SettledChannelV1<T>>> {
  if (tasks.length === 0) return [];
  const now = options.now ?? Date.now;
  const started = now();
  const abort = new AbortController();
  const results: Array<SettledChannelV1<T> | undefined> = tasks.map(
    () => undefined,
  );
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency, tasks.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const task = tasks[index];
        if (!task || abort.signal.aborted) return;
        try {
          const value = await task.run(abort.signal);
          if (!abort.signal.aborted)
            results[index] = { status: "complete", value };
        } catch {
          if (!abort.signal.aborted) results[index] = { status: "partial" };
        }
      }
    },
  );
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        abort.abort();
        resolve();
      },
      Math.max(0, options.deadlineMs - (now() - started)),
    );
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
  await Promise.race([Promise.all(workers).then(() => undefined), timeout]);
  abort.abort();
  return results.map((result) => result ?? { status: "partial" });
}

const NAME_PATTERN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;

/** True when a committed row shares a token with the query. Used for unindexed rows. */
export function memoryTextOverlapsV1(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return hay.includes(query.trim().toLowerCase());
  return tokens.some((token) => hay.includes(token));
}

/** Entity-shaped tokens from tool text. The text itself is not the query. */
export function entityNamesFromToolTextV1(text: string): string[] {
  const names = text.match(NAME_PATTERN) ?? [];
  const unique = new Set<string>();
  for (const name of names) {
    if (name.length < 3 || name.length > 80) continue;
    unique.add(name);
  }
  return [...unique].slice(0, 8);
}

export function followupMemoryQueryV1(input: {
  userText: string;
  toolTexts: readonly string[];
  seen: ReadonlySet<string>;
  searchesUsed: number;
}): { query: string; signature: string } | undefined {
  const limit =
    MEMORY_POLICY_V1.automaticInitialSearches +
    MEMORY_POLICY_V1.automaticAdditionalSearches;
  if (input.searchesUsed >= limit) return undefined;
  if (input.searchesUsed < MEMORY_POLICY_V1.automaticInitialSearches) {
    return undefined;
  }
  const entities = input.toolTexts.flatMap((text) =>
    entityNamesFromToolTextV1(text),
  );
  if (entities.length === 0) return undefined;
  const query = `${input.userText.trim()} ${entities.join(" ")}`.trim();
  const signature = query.toLowerCase().replace(/\s+/g, " ");
  if (!signature || input.seen.has(signature)) return undefined;
  return { query, signature };
}

export function initialMemoryQueryV1(
  userText: string,
  searchesUsed: number,
): { query: string; signature: string } | undefined {
  if (searchesUsed >= MEMORY_POLICY_V1.automaticInitialSearches)
    return undefined;
  if (isControlOnlyMemoryInputV1(userText)) return undefined;
  const query = userText.trim().slice(0, 500);
  const signature = query.toLowerCase().replace(/\s+/g, " ");
  return { query, signature };
}
