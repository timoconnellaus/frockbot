import { describe, expect, test } from "bun:test";
import {
  isRoutineTimezoneV1,
  missedRoutineRunsV1,
  nextRoutineRunV1,
  normalizeRoutineScheduleV1,
  RoutineScheduleError,
} from "./cron.js";

describe("normalizeRoutineScheduleV1", () => {
  test("accepts a five-field cron expression in the record's zone", () => {
    expect(
      normalizeRoutineScheduleV1("0 9 * * 1-5", "Australia/Sydney"),
    ).toEqual({
      kind: "cron",
      pattern: "0 9 * * 1-5",
      timezone: "Australia/Sydney",
    });
  });

  test("expands every shorthand alias to five fields", () => {
    const cases: Array<[string, string]> = [
      ["@hourly", "0 * * * *"],
      ["@daily", "0 0 * * *"],
      ["@weekly", "0 0 * * 0"],
      ["@monthly", "0 0 1 * *"],
    ];
    for (const [alias, pattern] of cases) {
      expect(normalizeRoutineScheduleV1(alias, "UTC")).toEqual({
        kind: "cron",
        pattern,
        timezone: "UTC",
      });
    }
  });

  test("reads a CRON_TZ= prefix as the schedule's own zone", () => {
    expect(
      normalizeRoutineScheduleV1("CRON_TZ=Europe/Berlin 30 6 * * *", "UTC"),
    ).toEqual({
      kind: "cron",
      pattern: "30 6 * * *",
      timezone: "Europe/Berlin",
    });
  });

  test("parses @every as a fixed interval", () => {
    expect(normalizeRoutineScheduleV1("@every 15m", "UTC")).toEqual({
      kind: "interval",
      intervalMs: 900_000,
      timezone: "UTC",
    });
    expect(
      (
        normalizeRoutineScheduleV1("@every 2h30m", "UTC") as {
          intervalMs: number;
        }
      ).intervalMs,
    ).toBe(9_000_000);
  });

  test("refuses a malformed cron expression", () => {
    for (const bad of ["not a cron", "0 9 * *", "99 * * * *", "0 9 * * * *"]) {
      expect(() => normalizeRoutineScheduleV1(bad, "UTC")).toThrow(
        RoutineScheduleError,
      );
    }
  });

  test("refuses an unknown alias and an unusable @every", () => {
    expect(() => normalizeRoutineScheduleV1("@fortnightly", "UTC")).toThrow(
      /not a known schedule alias/,
    );
    expect(() => normalizeRoutineScheduleV1("@every", "UTC")).toThrow(
      /needs a duration/,
    );
    expect(() => normalizeRoutineScheduleV1("@every 5s", "UTC")).toThrow(
      /at least one minute/,
    );
    expect(() => normalizeRoutineScheduleV1("@every 400d", "UTC")).toThrow(
      /at most one year/,
    );
  });

  test("refuses a time zone this runtime cannot format in", () => {
    expect(() => normalizeRoutineScheduleV1("@daily", "Mars/Olympus")).toThrow(
      /not an IANA time zone/,
    );
    expect(() =>
      normalizeRoutineScheduleV1("CRON_TZ=Mars/Olympus @daily", "UTC"),
    ).toThrow(/CRON_TZ/);
  });

  test("refuses an empty or oversized schedule", () => {
    expect(() => normalizeRoutineScheduleV1("   ", "UTC")).toThrow(
      /must not be empty/,
    );
    expect(() => normalizeRoutineScheduleV1("0 ".repeat(200), "UTC")).toThrow(
      /at most 256 characters/,
    );
  });
});

describe("isRoutineTimezoneV1", () => {
  test("accepts IANA names and refuses anything else", () => {
    expect(isRoutineTimezoneV1("Australia/Sydney")).toBe(true);
    expect(isRoutineTimezoneV1("UTC")).toBe(true);
    expect(isRoutineTimezoneV1("")).toBe(false);
    expect(isRoutineTimezoneV1("Not/AZone")).toBe(false);
    expect(isRoutineTimezoneV1(7)).toBe(false);
  });
});

describe("nextRoutineRunV1", () => {
  const anchor = new Date("2026-01-01T00:00:00.000Z");

  function next(schedule: string, timezone: string, from: string): string {
    const run = nextRoutineRunV1(
      normalizeRoutineScheduleV1(schedule, timezone),
      new Date(from),
      anchor,
    );
    if (!run) throw new Error("expected a next run");
    return run.toISOString();
  }

  test("keeps a wall-clock time across the end of Sydney daylight saving", () => {
    // Sydney leaves AEDT (UTC+11) for AEST (UTC+10) at 03:00 on 5 April 2026.
    // 09:00 local is 22:00Z the day before while AEDT holds, and 23:00Z after.
    expect(next("0 9 * * *", "Australia/Sydney", "2026-04-02T12:00:00Z")).toBe(
      "2026-04-02T22:00:00.000Z",
    );
    expect(next("0 9 * * *", "Australia/Sydney", "2026-04-04T12:00:00Z")).toBe(
      "2026-04-04T23:00:00.000Z",
    );
  });

  test("keeps a wall-clock time across the start of New York daylight saving", () => {
    // New York enters EDT at 02:00 on 8 March 2026: 09:00 local moves from
    // 14:00Z to 13:00Z, and the schedule does not drift with it.
    expect(next("0 9 * * *", "America/New_York", "2026-03-06T20:00:00Z")).toBe(
      "2026-03-07T14:00:00.000Z",
    );
    expect(next("0 9 * * *", "America/New_York", "2026-03-08T00:00:00Z")).toBe(
      "2026-03-08T13:00:00.000Z",
    );
  });

  test("reads CRON_TZ= as the zone the pattern is evaluated in", () => {
    // The record says UTC; the schedule the user typed overrides it. At
    // 00:00Z it is already 10:00 in Sydney, so the next 09:00 there is the
    // following morning — 23:00Z, not 09:00Z.
    expect(
      next("CRON_TZ=Australia/Sydney 0 9 * * *", "UTC", "2026-06-01T00:00:00Z"),
    ).toBe("2026-06-01T23:00:00.000Z");
    expect(next("0 9 * * *", "UTC", "2026-06-01T00:00:00Z")).toBe(
      "2026-06-01T09:00:00.000Z",
    );
  });

  test("fires @daily at local midnight", () => {
    expect(next("@daily", "Australia/Sydney", "2026-06-01T00:00:00Z")).toBe(
      "2026-06-01T14:00:00.000Z",
    );
  });

  test("counts @every 5m forward from its anchor, not from the asking time", () => {
    const normalized = normalizeRoutineScheduleV1("@every 5m", "UTC");
    expect(
      nextRoutineRunV1(
        normalized,
        new Date("2026-01-01T00:07:30.000Z"),
        anchor,
      )?.toISOString(),
    ).toBe("2026-01-01T00:10:00.000Z");
    expect(nextRoutineRunV1(normalized, anchor, anchor)?.toISOString()).toBe(
      "2026-01-01T00:05:00.000Z",
    );
  });
});

describe("missedRoutineRunsV1", () => {
  const anchor = new Date("2026-01-01T00:00:00.000Z");

  test("counts the elapsed occurrences of a cron, the one firing included", () => {
    expect(
      missedRoutineRunsV1(
        normalizeRoutineScheduleV1("0 * * * *", "UTC"),
        new Date("2026-01-01T01:00:00Z"),
        new Date("2026-01-01T04:30:00Z"),
        anchor,
      ),
    ).toBe(4);
  });

  test("counts an interval schedule arithmetically", () => {
    expect(
      missedRoutineRunsV1(
        normalizeRoutineScheduleV1("@every 5m", "UTC"),
        new Date("2026-01-01T00:05:00Z"),
        new Date("2026-01-01T00:32:00Z"),
        anchor,
      ),
    ).toBe(6);
  });

  test("counts nothing when the occurrence has not arrived", () => {
    expect(
      missedRoutineRunsV1(
        normalizeRoutineScheduleV1("@daily", "UTC"),
        new Date("2026-01-02T00:00:00Z"),
        new Date("2026-01-01T00:00:00Z"),
        anchor,
      ),
    ).toBe(0);
  });
});
