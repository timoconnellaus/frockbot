/** Whether one generation has settled successfully. */
export type GenerationOutcome = "pending" | "good" | "bad";

/** One full plugin list in an append-only generation log. */
export interface Generation<
  TEntry extends { id: string; enabled?: boolean } = {
    id: string;
    enabled?: boolean;
  },
> {
  n: number;
  parent: number | null;
  at: number;
  baseVersion: string;
  entries: Array<TEntry>;
  outcome: GenerationOutcome;
}

/** The status needed to settle one enabled generation entry. */
export interface GenerationStatus {
  id: string;
  status: string;
}

/** Append a pending generation after the current head. */
export function appendGeneration<
  TEntry extends { id: string; enabled?: boolean },
>(
  log: ReadonlyArray<Generation<TEntry>>,
  input: { entries: ReadonlyArray<TEntry>; baseVersion: string },
): Array<Generation<TEntry>> {
  const head = log.at(-1);
  return [
    ...log,
    {
      n: (head?.n ?? -1) + 1,
      parent: head?.n ?? null,
      at: Date.now(),
      baseVersion: input.baseVersion,
      entries: [...input.entries],
      outcome: "pending",
    },
  ];
}

/** Finalise a pending generation from the statuses of its enabled entries. */
export function recordOutcome<TEntry extends { id: string; enabled?: boolean }>(
  log: ReadonlyArray<Generation<TEntry>>,
  n: number,
  statuses: ReadonlyArray<GenerationStatus>,
): Array<Generation<TEntry>> {
  const statusById = new Map(
    statuses.map((status) => [status.id, status.status]),
  );
  return log.map((generation) => {
    if (generation.n !== n || generation.outcome !== "pending") {
      return generation;
    }
    const good = generation.entries
      .filter((entry) => entry.enabled !== false)
      .every((entry) => statusById.get(entry.id) === "active");
    return { ...generation, outcome: good ? "good" : "bad" };
  });
}

/** Return the newest generation whose enabled entries all became active. */
export function lastKnownGood<TEntry extends { id: string; enabled?: boolean }>(
  log: ReadonlyArray<Generation<TEntry>>,
): Generation<TEntry> | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const generation = log[index];
    if (generation?.outcome === "good") return generation;
  }
  return undefined;
}

/** Append an earlier entry list as a new generation under the current base. */
export function revertTo<TEntry extends { id: string; enabled?: boolean }>(
  log: ReadonlyArray<Generation<TEntry>>,
  n: number,
): Array<Generation<TEntry>> {
  const target = log.find((generation) => generation.n === n);
  const head = log.at(-1);
  if (!target || !head) return [...log];
  return appendGeneration(log, {
    entries: target.entries,
    baseVersion: head.baseVersion,
  });
}
