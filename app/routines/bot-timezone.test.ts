import { expect, test } from "bun:test";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  projectRoutineAccountTimezoneV1,
  routineAccountTimezoneV1,
} from "./bot.js";
import {
  ROUTINE_ACCOUNT_TIMEZONE_KEY,
  routineScheduleKeyV1,
} from "./storage-keys.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";

function fixture() {
  const storage = createMemoryRoutineStorageV1();
  let refreshes = 0;
  const state = {
    ctx: { storage },
    authority: {
      async refreshRecoveryAlarm() {
        refreshes += 1;
      },
    },
  } as unknown as ShellBotStateV1;
  return { storage, state, refreshes: () => refreshes };
}

const CLOCK = {
  schemaVersion: 1,
  routineId: "brief",
  anchor: "2026-08-01T00:00:00.000Z",
  timezone: "UTC",
  dueAt: Date.parse("2026-09-11T09:00:00.000Z"),
  consecutiveFailures: 3,
  deferredUntil: Date.parse("2026-09-11T08:00:00.000Z"),
};

test("a newer Profile timezone wins and re-arms the alarm", async () => {
  const { storage, state, refreshes } = fixture();

  await projectRoutineAccountTimezoneV1(state, "Australia/Sydney", 7);
  expect(await routineAccountTimezoneV1(storage)).toBe("Australia/Sydney");
  expect(refreshes()).toBe(1);

  await projectRoutineAccountTimezoneV1(state, "Pacific/Auckland", 6);
  expect(await routineAccountTimezoneV1(storage)).toBe("Australia/Sydney");
  expect(refreshes()).toBe(1);
});

test("a settings revision that moved no zone leaves every clock untouched", async () => {
  const { storage, state } = fixture();
  await storage.put(routineScheduleKeyV1("brief"), CLOCK);

  // Every user settings command bumps the revision, model changes included.
  await projectRoutineAccountTimezoneV1(state, "UTC", 9);
  await projectRoutineAccountTimezoneV1(state, "UTC", 10);

  // The debt, the failure backoff and the hold all survive it: a clock is
  // recomputed by the zone it names, never discarded by an unrelated save.
  expect(await storage.get<unknown>(routineScheduleKeyV1("brief"))).toEqual(
    CLOCK,
  );
});

test("an absent or malformed account projection falls back to UTC", async () => {
  const { storage } = fixture();
  expect(await routineAccountTimezoneV1(storage)).toBe("UTC");
  await storage.put(ROUTINE_ACCOUNT_TIMEZONE_KEY, "Australia/Sydney");
  expect(await routineAccountTimezoneV1(storage)).toBe("UTC");
});
