import { describe, expect, test } from "bun:test";
import {
  isRoutineTimezoneV1,
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
