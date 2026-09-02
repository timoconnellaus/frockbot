// The Bot Durable Object storage keys the Routines Package owns.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, and Routines". The keys live here rather than in
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
/** One `RoutineHookKeyV1`: the authoritative digest of a Routine's webhook key. */
export const ROUTINE_KEY_PREFIX = "routine-key:";
/** One accepted delivery, so a replay answers with the firing it already made. */
export const ROUTINE_DELIVERY_PREFIX = "routine-delivery:";

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

export function routineHookKeyRecordV1(routineId: string): string {
  return `${ROUTINE_KEY_PREFIX}${routineId}`;
}

export function routineDeliveryKeyV1(deliveryId: string): string {
  return `${ROUTINE_DELIVERY_PREFIX}${deliveryId}`;
}

/** One `RoutineInboxEntryV1`, newest first. */
export const ROUTINE_INBOX_PREFIX = "routine-inbox:";
/** The inbox's monotonic sequence. Read by key, because the terminal seam cannot list. */
export const ROUTINE_INBOX_CURSOR_KEY = "routine-inbox-cursor";
/** One `PendingBotInputV1`, oldest first: a queue drains in the order it filled. */
export const ROUTINE_WAKE_PREFIX = "routine-wake:";
/** The pending-input queue's monotonic sequence. */
export const ROUTINE_WAKE_CURSOR_KEY = "routine-wake-cursor";
/** What one chat Turn drained, so a resumed Turn reproduces the same input. */
export const ROUTINE_DRAIN_PREFIX = "routine-drain:";

/**
 * Most completion-inbox entries retained. Past it the oldest are trimmed on the
 * next read: an entry is a convenience index over runs that are still durable,
 * so trimming loses a row and never a fact.
 */
export const ROUTINE_INBOX_LIMIT = 100;

/**
 * Most pending inputs the Bot's next conversational Turn may be owed. A Bot
 * that has not been spoken to in sixteen firings is not helped by a
 * seventeenth hand-off; the oldest is dropped, and its inbox entry — which is
 * the durable record — stays.
 */
export const ROUTINE_PENDING_INPUT_LIMIT = 16;

/** Most drain receipts retained; one is only needed while its Turn is running. */
export const ROUTINE_DRAIN_RECEIPT_LIMIT = 16;

export function routineInboxKeyV1(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= RUN_SEQUENCE_CEILING) {
    throw new Error("Routine inbox sequence is out of range");
  }
  const descending = RUN_SEQUENCE_CEILING - seq;
  return `${ROUTINE_INBOX_PREFIX}${String(descending).padStart(10, "0")}`;
}

export function routineWakeKeyV1(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= RUN_SEQUENCE_CEILING) {
    throw new Error("Routine wake sequence is out of range");
  }
  return `${ROUTINE_WAKE_PREFIX}${String(seq).padStart(10, "0")}`;
}

export function routineDrainKeyV1(runId: string): string {
  return `${ROUTINE_DRAIN_PREFIX}${runId}`;
}

/**
 * The sequence a cursor record holds. The cursor exists because the terminal
 * seam is handed a reader and not a lister: a Package record written in the
 * settling transaction must be addressable by key alone.
 */
export interface RoutineSequenceCursorV1 {
  schemaVersion: 1;
  nextSeq: number;
}

export function routineSequenceCursorV1(
  value: unknown,
): RoutineSequenceCursorV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Number.isSafeInteger((value as { nextSeq?: unknown }).nextSeq) ||
    (value as { nextSeq: number }).nextSeq < 0
  ) {
    return { schemaVersion: 1, nextSeq: 0 };
  }
  return { schemaVersion: 1, nextSeq: (value as { nextSeq: number }).nextSeq };
}
