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
  /** The User Profile timezone this derived clock was computed under. */
  timezone: string;
  /** Epoch milliseconds the Routine is next owed a firing. */
  dueAt: number;
  /** Epoch milliseconds before which the alarm must not settle this Routine. */
  deferredUntil?: number;
  /**
   * Firings that failed in a row, reset by the first that did not.
   *
   * It is on the clock rather than on the record because it is timing state:
   * what it buys is the backoff `deferredUntil` carries, and the auto-pause it
   * ends in.
   */
  consecutiveFailures?: number;
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
    ["schemaVersion", "routineId", "anchor", "timezone", "dueAt"],
    ["deferredUntil", "consecutiveFailures"],
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
    timezone: routineText(
      candidate.timezone,
      64,
      "Routine schedule state timezone",
    ),
    dueAt: epoch(candidate.dueAt, "Routine schedule state dueAt"),
    ...(candidate.deferredUntil === undefined
      ? {}
      : {
          deferredUntil: epoch(
            candidate.deferredUntil,
            "Routine schedule state deferredUntil",
          ),
        }),
    ...(candidate.consecutiveFailures === undefined
      ? {}
      : {
          consecutiveFailures: count(
            candidate.consecutiveFailures,
            "Routine schedule state consecutiveFailures",
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
    entryId: routineText(candidate.entryId, 256, "Routine firing entryId"),
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
 * Longest fire id there is, because a fire id *is* a run id: the stored run
 * codec holds one to the public-identifier grammar and the transcript
 * projection truncates at the same 128. A longer one could never be admitted
 * at all — the Turn failed before it started — and every identity derived from
 * it, the message a person reads the firing under and the unread boundary that
 * clears it, was out of grammar with it.
 */
export const ROUTINE_FIRE_ID_MAX_LENGTH = 128;

/**
 * The SHA-256 round constants.
 */
const SHA256_ROUND_CONSTANTS_V1 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256, computed without awaiting.
 *
 * `crypto.subtle` is the repository's digest everywhere a digest may be
 * awaited. A fire id is minted inside the storage transaction that claims the
 * firing, where the only promises the transaction may hold are its own reads
 * and writes, so this one is computed in place.
 */
function sha256HexV1(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15]!;
      const recent = schedule[index - 2]!;
      const s0 =
        (rotr32(previous, 7) ^ rotr32(previous, 18) ^ (previous >>> 3)) >>> 0;
      const s1 =
        (rotr32(recent, 17) ^ rotr32(recent, 19) ^ (recent >>> 10)) >>> 0;
      schedule[index] =
        (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const t1 =
        (h +
          s1 +
          choose +
          SHA256_ROUND_CONSTANTS_V1[index]! +
          schedule[index]!) >>>
        0;
      const s0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * How much of the digest a shortened fire id carries. 128 bits: the id is a
 * durable idempotency key, and two firings that shared one would make the
 * kernel refuse the second as a replay of the first — work a person asked for,
 * silently dropped. A 32-bit digest collided within a few thousand ordinary
 * firing inputs, which is not a bound anything durable may rest on.
 */
const FIRE_ID_DIGEST_LENGTH_V1 = 32;

/**
 * A stable digest of the whole id, so shortening one keeps it that firing's
 * own: a scheduled occurrence and a delivery of the same long-named Routine
 * share a truncated prefix, and sharing an id would make the kernel refuse the
 * second as a replay of the first.
 */
function fireIdDigestV1(value: string): string {
  return sha256HexV1(value).slice(0, FIRE_ID_DIGEST_LENGTH_V1);
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
  const full = `rf-${routineId}-${sanitized}`;
  if (full.length <= ROUTINE_FIRE_ID_MAX_LENGTH) return full;
  const digest = fireIdDigestV1(full);
  return `${full.slice(0, ROUTINE_FIRE_ID_MAX_LENGTH - digest.length - 1)}-${digest}`;
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
