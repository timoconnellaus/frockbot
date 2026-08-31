// The Bot Durable Object storage keys the Routines Package owns.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, Assignments". The keys live here rather than in
// `@frockbot/kernel-do` because the kernel imports no Package and holds no
// product policy; the Durable Object hands this Package a storage seam and this
// module decides what it writes under.

/** One `RoutineRecordV1`. */
export const ROUTINE_PREFIX = "routine:";
/** One `RoutineRunEntryV1`, newest first. */
export const ROUTINE_RUN_PREFIX = "routine-run:";
/** One durable command receipt, keyed by the command's idempotency key. */
export const ROUTINE_RECEIPT_PREFIX = "routine-receipt:";

/** Most run entries retained per Routine. Trimming loses index rows, never facts. */
export const ROUTINE_RUN_LOG_LIMIT = 50;

/** Most Routines one Bot may hold. */
export const ROUTINE_LIMIT_PER_BOT = 100;

/**
 * Run entries are keyed by a descending sequence so a prefix listing returns
 * the newest first without reading the whole log.
 */
const RUN_SEQUENCE_CEILING = 1_000_000_000;

export function routineKeyV1(routineId: string): string {
  return `${ROUTINE_PREFIX}${routineId}`;
}

export function routineRunPrefixV1(routineId: string): string {
  return `${ROUTINE_RUN_PREFIX}${routineId}:`;
}

export function routineRunKeyV1(routineId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= RUN_SEQUENCE_CEILING) {
    throw new Error("Routine run sequence is out of range");
  }
  const descending = RUN_SEQUENCE_CEILING - seq;
  return `${routineRunPrefixV1(routineId)}${String(descending).padStart(10, "0")}`;
}

export function routineReceiptKeyV1(commandId: string): string {
  return `${ROUTINE_RECEIPT_PREFIX}${commandId}`;
}

/**
 * The sequence the next run entry takes, given the keys already stored. Keys
 * descend so the newest sorts first; the next entry is one past whichever
 * sequence the newest key encodes, and trimming never reuses a sequence.
 */
export function nextRunSequenceV1(keys: readonly string[]): number {
  let highest = -1;
  for (const key of keys) {
    const encoded = Number(key.slice(key.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(encoded)) continue;
    highest = Math.max(highest, RUN_SEQUENCE_CEILING - encoded);
  }
  return highest + 1;
}
