// The durable records the scheduler owns: when a Routine is next due, and the
// one firing of it that has not settled yet.
//
// Two records, two jobs.
//
//   * `RoutineScheduleStateV1` is the Routine's clock. `dueAt` is the debt: the
//     moment the Routine was owed a firing, and it moves only when a firing is
//     minted for it. `deferredUntil` is a hold, set when the object is busy, and
//     it never moves `dueAt` — pushing `dueAt` forward would silently skip a
//     firing, which is the one thing a scheduler must not do. `anchor` records
//     the record revision the clock was computed under, so editing a Routine's
//     schedule recomputes it instead of inheriting a due time from the old one.
//
//   * `RoutineFireV1` is one firing, written durably *before* the Turn it
//     admits. It doubles as the same-Routine lock: at most one exists per
//     Routine, and a firing that arrives while one is unsettled queues behind
//     it. "Record durable execution intent before invoking an external side
//     effect", and "retries reuse the fire id as the run id".
import {
  isRoutineIdV1,
  RoutineDecodeError,
  routineExactKeys,
  routineText,
  routineTimestamp,
  ROUTINE_TRIGGER_KINDS,
  type RoutineTriggerKindV1,
} from "./records.js";

/** A Routine's durable clock. Absent means "compute it from the record". */
export interface RoutineScheduleStateV1 {
  schemaVersion: 1;
  routineId: string;
  /** The record revision this clock was computed under: the record's `updatedAt`. */
  anchor: string;
  /** Epoch milliseconds the Routine is next owed a firing. */
  dueAt: number;
  /** Epoch milliseconds before which the alarm must not settle this Routine. */
  deferredUntil?: number;
}

/** One firing, durable before the Turn it admits. The same-Routine lock. */
export interface RoutineFireV1 {
  schemaVersion: 1;
  routineId: string;
  /** The run id the Turn is admitted under; a retry reuses it. */
  fireId: string;
  trigger: RoutineTriggerKindV1;
  /** The cue text the Turn is admitted with. */
  cue: string;
  /** When the firing was minted. */
  mintedAt: string;
  /** The occurrence this firing settles, for a scheduled Routine. */
  dueAt?: number;
  /** How many occurrences this firing coalesces, when it fired late. */
  missedCount?: number;
  /** The run-log entry this firing writes and later rewrites. */
  entryId: string;
}

/**
 * Longest cue a firing may carry. A Routine prompt is capped at 8 000
 * characters and a webhook rendering at 4 KiB; this leaves room for both and
 * the framing between them.
 */
export const ROUTINE_CUE_MAX_LENGTH = 16_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoutineDecodeError(`${label} must be epoch milliseconds`);
  }
  return value as number;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoutineDecodeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

export function decodeRoutineScheduleStateV1(
  value: unknown,
): RoutineScheduleStateV1 {
  const candidate = record(value, "Routine schedule state");
  routineExactKeys(
    candidate,
    ["schemaVersion", "routineId", "anchor", "dueAt"],
    ["deferredUntil"],
    "Routine schedule state",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine schedule state schemaVersion is unsupported",
    );
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine schedule state routineId is invalid");
  }
  return {
    schemaVersion: 1,
    routineId: candidate.routineId,
    anchor: routineTimestamp(candidate.anchor, "Routine schedule state anchor"),
    dueAt: epoch(candidate.dueAt, "Routine schedule state dueAt"),
    ...(candidate.deferredUntil === undefined
      ? {}
      : {
          deferredUntil: epoch(
            candidate.deferredUntil,
            "Routine schedule state deferredUntil",
          ),
        }),
  };
}

export function decodeRoutineFireV1(value: unknown): RoutineFireV1 {
  const candidate = record(value, "Routine firing");
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "routineId",
      "fireId",
      "trigger",
      "cue",
      "mintedAt",
      "entryId",
    ],
    ["dueAt", "missedCount"],
    "Routine firing",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError("Routine firing schemaVersion is unsupported");
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine firing routineId is invalid");
  }
  const trigger = ROUTINE_TRIGGER_KINDS.find(
    (known) => known === candidate.trigger,
  );
  if (!trigger) {
    throw new RoutineDecodeError("Routine firing trigger is invalid");
  }
  return {
    schemaVersion: 1,
    routineId: candidate.routineId,
    fireId: routineText(candidate.fireId, 256, "Routine firing fireId"),
    trigger,
    cue: routineText(
      candidate.cue,
      ROUTINE_CUE_MAX_LENGTH,
      "Routine firing cue",
    ),
    mintedAt: routineTimestamp(candidate.mintedAt, "Routine firing mintedAt"),
    entryId: routineText(candidate.entryId, 128, "Routine firing entryId"),
    ...(candidate.dueAt === undefined
      ? {}
      : { dueAt: epoch(candidate.dueAt, "Routine firing dueAt") }),
    ...(candidate.missedCount === undefined
      ? {}
      : {
          missedCount: count(
            candidate.missedCount,
            "Routine firing missedCount",
          ),
        }),
  };
}

/** The Session a Routine's firings run in. One per Routine, never the User's. */
export function routineSessionIdV1(routineId: string): string {
  return `routine:${routineId}`;
}

/**
 * The run id one firing is admitted under. It is derived, not random: a
 * scheduled occurrence names its own due time and a delivered one names its
 * delivery, so a retry after eviction reuses the id and the kernel's own
 * fingerprint idempotency refuses the second admission rather than running the
 * Routine twice.
 */
export function routineFireIdV1(
  routineId: string,
  discriminator: string,
): string {
  const sanitized = discriminator.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return `rf-${routineId}-${sanitized}`.slice(0, 250);
}

/**
 * What the Turn is admitted with. A firing is not a message from a person, so
 * the cue says what fired and why, and then hands over the Routine's own
 * instruction verbatim.
 */
export function routineCueV1(input: {
  name: string;
  prompt: string;
  trigger: RoutineTriggerKindV1;
  missedCount?: number;
  delivery?: string;
}): string {
  const lines = [
    `Routine "${input.name}" fired (${input.trigger}).`,
    ...(input.missedCount && input.missedCount > 1
      ? [
          `It was late: ${input.missedCount} scheduled occurrences elapsed and this firing covers all of them.`,
        ]
      : []),
    "",
    input.prompt,
  ];
  if (input.delivery !== undefined) {
    lines.push("", "Delivered payload:", input.delivery);
  }
  return lines.join("\n").slice(0, ROUTINE_CUE_MAX_LENGTH);
}
