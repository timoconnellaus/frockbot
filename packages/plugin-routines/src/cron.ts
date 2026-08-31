// Schedule syntax: the one place a Routine's `schedule` string is understood.
//
// D1 validates syntax at write time and nothing else. "Timezone is validated
// with `Intl.DateTimeFormat` at *write* time so a bad TZ is a rejected command,
// not a dead alarm" — the same rule applies to the pattern itself: a Routine
// whose schedule cannot be parsed is never written, so the scheduler that
// arrives in D2 can assume every stored schedule is parseable.
//
// `croner` owns 5-field cron and IANA timezones. It does not understand
// GrokBot's `CRON_TZ=` prefix, its `@shorthand` aliases, or `@every <duration>`,
// so this module owns exactly that normalization and hands the rest over.
import { Cron } from "croner";

/** Longest schedule string a command may carry. */
export const ROUTINE_SCHEDULE_MAX_LENGTH = 256;

/** The shortest `@every` interval a Routine may ask for. */
export const ROUTINE_MIN_INTERVAL_MS = 60_000;
/** The longest `@every` interval a Routine may ask for: one year. */
export const ROUTINE_MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;

/** A schedule after normalization: either a cron pattern or a fixed interval. */
export type NormalizedScheduleV1 =
  | { kind: "cron"; pattern: string; timezone: string }
  | { kind: "interval"; intervalMs: number; timezone: string };

export class RoutineScheduleError extends Error {
  override readonly name = "RoutineScheduleError";
}

const CRON_SHORTHANDS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * True when the IANA name is one this runtime can actually format in. An
 * unknown zone throws `RangeError` here rather than silently resolving to UTC
 * later, which is the whole reason the check happens at write time.
 */
export function isRoutineTimezoneV1(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `@every 15m`, `@every 2h30m`, `@every 90s`. */
function parseEveryDuration(rest: string): number {
  const trimmed = rest.trim();
  if (trimmed.length === 0) {
    throw new RoutineScheduleError(
      "@every needs a duration, such as @every 15m",
    );
  }
  const parts = trimmed.match(/\d+[smhd]/g);
  if (!parts || parts.join("") !== trimmed.replace(/\s+/g, "")) {
    throw new RoutineScheduleError(
      `"@every ${rest.trim()}" is not a duration; use units s, m, h or d, such as @every 15m`,
    );
  }
  let total = 0;
  for (const part of parts) {
    const unit = part.slice(-1);
    total += Number(part.slice(0, -1)) * DURATION_UNITS_MS[unit]!;
  }
  if (total < ROUTINE_MIN_INTERVAL_MS) {
    throw new RoutineScheduleError("@every must be at least one minute apart");
  }
  if (total > ROUTINE_MAX_INTERVAL_MS) {
    throw new RoutineScheduleError("@every must be at most one year apart");
  }
  return total;
}

/**
 * Normalize and validate a schedule string against the Routine's timezone.
 *
 * A `CRON_TZ=` prefix wins over the record's `timezone`, matching GrokBot,
 * because it is written into the schedule the user typed. Both are validated;
 * neither is guessed.
 */
export function normalizeRoutineScheduleV1(
  schedule: string,
  timezone: string,
): NormalizedScheduleV1 {
  if (typeof schedule !== "string") {
    throw new RoutineScheduleError("schedule must be a string");
  }
  const raw = schedule.trim();
  if (raw.length === 0) {
    throw new RoutineScheduleError("schedule must not be empty");
  }
  if (raw.length > ROUTINE_SCHEDULE_MAX_LENGTH) {
    throw new RoutineScheduleError(
      `schedule must be at most ${ROUTINE_SCHEDULE_MAX_LENGTH} characters`,
    );
  }
  if (!isRoutineTimezoneV1(timezone)) {
    throw new RoutineScheduleError(
      `timezone "${timezone}" is not an IANA time zone`,
    );
  }
  let body = raw;
  let zone = timezone;
  const prefix = /^CRON_TZ=(\S+)\s+(.*)$/.exec(body);
  if (prefix) {
    const declared = prefix[1]!;
    if (!isRoutineTimezoneV1(declared)) {
      throw new RoutineScheduleError(
        `CRON_TZ="${declared}" is not an IANA time zone`,
      );
    }
    zone = declared;
    body = prefix[2]!.trim();
  }
  if (body.length === 0) {
    throw new RoutineScheduleError("schedule must not be empty");
  }
  if (body.startsWith("@every")) {
    const rest = body.slice("@every".length);
    if (rest.length > 0 && !/^\s/.test(rest)) {
      throw new RoutineScheduleError(`"${body}" is not a known schedule alias`);
    }
    return {
      kind: "interval",
      intervalMs: parseEveryDuration(rest),
      timezone: zone,
    };
  }
  if (body.startsWith("@")) {
    const expanded = CRON_SHORTHANDS[body.toLowerCase()];
    if (!expanded) {
      throw new RoutineScheduleError(`"${body}" is not a known schedule alias`);
    }
    body = expanded;
  }
  const fields = body.split(/\s+/);
  if (fields.length !== 5) {
    throw new RoutineScheduleError(
      `cron expression "${body}" must have five fields (minute hour day month weekday)`,
    );
  }
  try {
    // Constructing without a callback parses and validates; it schedules
    // nothing. `stop` is called so no timer survives the check.
    const parsed = new Cron(body, { timezone: zone, paused: true });
    parsed.stop();
  } catch (error) {
    throw new RoutineScheduleError(
      `cron expression "${body}" is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { kind: "cron", pattern: body, timezone: zone };
}

/** A one-line summary of a schedule for a list row. */
export function describeRoutineScheduleV1(schedule: string): string {
  return schedule.trim();
}
