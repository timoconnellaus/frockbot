import { describe, expect, test } from "bun:test";
import {
  decodeRoutineRecordV1,
  decodeRoutineRunEntryV1,
  decodeRoutineWriterV1,
  RoutineDecodeError,
  ROUTINE_PROMPT_MAX_LENGTH,
} from "./records.js";

const base = {
  schemaVersion: 1,
  routineId: "morning-brief",
  name: "Morning brief",
  prompt: "Summarize overnight email.",
  schedule: "0 7 * * *",
  timezone: "Australia/Sydney",
  enabled: true,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("RoutineRecordV1", () => {
  test("decodes a scheduled Routine written by its User", () => {
    expect(decodeRoutineRecordV1(base)).toMatchObject({
      routineId: "morning-brief",
      schedule: "0 7 * * *",
      enabled: true,
      createdBy: { kind: "user" },
    });
  });

  test("decodes a webhook Routine, which records the trigger kind and no key", () => {
    const { schedule: _schedule, ...rest } = base;
    const decoded = decodeRoutineRecordV1({
      ...rest,
      trigger: { kind: "webhook" },
    });
    expect(decoded.trigger).toEqual({ kind: "webhook" });
    expect(decoded.schedule).toBeUndefined();
    expect(Object.keys(decoded)).not.toContain("key");
  });

  test("refuses both a schedule and a trigger, and refuses neither", () => {
    expect(() =>
      decodeRoutineRecordV1({ ...base, trigger: { kind: "webhook" } }),
    ).toThrow(/never both/);
    const { schedule: _schedule, ...rest } = base;
    expect(() => decodeRoutineRecordV1(rest)).toThrow(
      /needs a schedule or a trigger/,
    );
  });

  test("refuses an oversized prompt", () => {
    expect(() =>
      decodeRoutineRecordV1({
        ...base,
        prompt: "x".repeat(ROUTINE_PROMPT_MAX_LENGTH + 1),
      }),
    ).toThrow(/at most 8000 characters/);
  });

  test("refuses an unknown field, a missing field, and a future version", () => {
    expect(() => decodeRoutineRecordV1({ ...base, extra: 1 })).toThrow(
      /unknown field "extra"/,
    );
    const { name: _name, ...missing } = base;
    expect(() => decodeRoutineRecordV1(missing)).toThrow(/is missing "name"/);
    expect(() => decodeRoutineRecordV1({ ...base, schemaVersion: 2 })).toThrow(
      /schemaVersion is unsupported/,
    );
  });

  test("refuses a trigger kind no delivery exists for", () => {
    const { schedule: _schedule, ...rest } = base;
    expect(() =>
      decodeRoutineRecordV1({ ...rest, trigger: { kind: "slack" } }),
    ).toThrow(RoutineDecodeError);
  });
});

describe("RoutineWriterV1", () => {
  test("a Bot writer names the Session and Turn that produced the write", () => {
    expect(
      decodeRoutineWriterV1({
        kind: "bot",
        botId: "scout",
        sessionId: "user:scout",
        turnId: "turn-3",
      }),
    ).toEqual({
      kind: "bot",
      botId: "scout",
      sessionId: "user:scout",
      turnId: "turn-3",
    });
  });

  test("refuses a Bot writer with no provenance and an unknown kind", () => {
    expect(() =>
      decodeRoutineWriterV1({ kind: "bot", botId: "scout" }),
    ).toThrow(/is missing "sessionId"/);
    expect(() => decodeRoutineWriterV1({ kind: "cron" })).toThrow(
      /kind is invalid/,
    );
  });
});

describe("RoutineRunEntryV1", () => {
  const entry = {
    schemaVersion: 1,
    entryId: "entry-1",
    routineId: "morning-brief",
    runId: "fire-1",
    fireId: "fire-1",
    trigger: "cron",
    status: "ok",
    startedAt: "2026-08-31T07:00:00.000Z",
  };

  test("decodes every declared status", () => {
    for (const status of ["running", "ok", "failed", "skipped", "cancelled"]) {
      expect(decodeRoutineRunEntryV1({ ...entry, status }).status).toBe(
        status as never,
      );
    }
  });

  test("refuses a status and a trigger outside the vocabulary", () => {
    expect(() => decodeRoutineRunEntryV1({ ...entry, status: "done" })).toThrow(
      /status is invalid/,
    );
    expect(() =>
      decodeRoutineRunEntryV1({ ...entry, trigger: "clock" }),
    ).toThrow(/trigger is invalid/);
  });
});
