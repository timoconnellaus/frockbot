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

test("a newer Profile timezone wins and rebuilds derived Routine clocks", async () => {
  const { storage, state, refreshes } = fixture();
  await storage.put(routineScheduleKeyV1("brief"), { dueAt: 1 });

  await projectRoutineAccountTimezoneV1(state, "Australia/Sydney", 7);
  expect(await routineAccountTimezoneV1(storage)).toBe("Australia/Sydney");
  expect(storage.keys()).toEqual([ROUTINE_ACCOUNT_TIMEZONE_KEY]);
  expect(refreshes()).toBe(1);

  await projectRoutineAccountTimezoneV1(state, "Pacific/Auckland", 6);
  expect(await routineAccountTimezoneV1(storage)).toBe("Australia/Sydney");
  expect(refreshes()).toBe(1);
});

test("an absent or malformed account projection falls back to UTC", async () => {
  const { storage } = fixture();
  expect(await routineAccountTimezoneV1(storage)).toBe("UTC");
  await storage.put(ROUTINE_ACCOUNT_TIMEZONE_KEY, "Australia/Sydney");
  expect(await routineAccountTimezoneV1(storage)).toBe("UTC");
});
