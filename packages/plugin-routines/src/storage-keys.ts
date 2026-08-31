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
/** One `RoutineScheduleStateV1`: when the Routine is next owed a firing. */
export const ROUTINE_SCHEDULE_PREFIX = "routine-schedule:";
/** The one unsettled `RoutineFireV1` of a Routine. This is the same-Routine lock. */
export const ROUTINE_FIRE_PREFIX = "routine-fire:";
/** Firings waiting behind the unsettled one, oldest first. */
export const ROUTINE_QUEUE_PREFIX = "routine-queue:";

/** Most run entries retained per Routine. Trimming loses index rows, never facts. */
export const ROUTINE_RUN_LOG_LIMIT = 50;

/** Most Routines one Bot may hold. */
export const ROUTINE_LIMIT_PER_BOT = 100;

/**
 * Most firings that may wait behind a Routine's unsettled one. Beyond it a
 * firing is refused and recorded as `skipped` rather than dropped silently:
 * "Failures are observable through durable state".
 */
export const ROUTINE_QUEUE_LIMIT = 8;

/**
 * How late a scheduled firing may be before it coalesces. Past it the Routine
 * fires once, records how many occurrences it covered, and recomputes from now;
 * it never backfills.
 */
export const ROUTINE_MISSED_GRACE_MS = 5 * 60_000;

/** How long a deferral holds the alarm off a Routine while the object is busy. */
export const ROUTINE_DEFERRAL_MS = 15_000;

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

export function routineScheduleKeyV1(routineId: string): string {
  return `${ROUTINE_SCHEDULE_PREFIX}${routineId}`;
}

export function routineFireKeyV1(routineId: string): string {
  return `${ROUTINE_FIRE_PREFIX}${routineId}`;
}

export function routineQueuePrefixV1(routineId: string): string {
  return `${ROUTINE_QUEUE_PREFIX}${routineId}:`;
}

/**
 * Queue keys ascend, so a prefix listing returns the oldest waiting firing
 * first: a queue drains in the order the firings were owed.
 */
export function routineQueueKeyV1(routineId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= RUN_SEQUENCE_CEILING) {
    throw new Error("Routine queue sequence is out of range");
  }
  return `${routineQueuePrefixV1(routineId)}${String(seq).padStart(10, "0")}`;
}

/** The sequence the next queued firing takes, given the keys already stored. */
export function nextQueueSequenceV1(keys: readonly string[]): number {
  let highest = -1;
  for (const key of keys) {
    const encoded = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isSafeInteger(encoded)) highest = Math.max(highest, encoded);
  }
  return highest + 1;
}
