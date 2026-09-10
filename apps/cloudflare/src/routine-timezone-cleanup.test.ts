import { expect, test } from "bun:test";
import { cleanRoutineTimezoneTestStateV1 } from "./routine-timezone-cleanup.js";

function fixture() {
  const values = new Map<string, unknown>([
    ["identity", { userId: "user", botId: "bot" }],
    ["bot-configuration", { profile: { name: "Bot" } }],
    ["run:chat", { status: "completed" }],
    ["routine:morning", { timezone: "Australia/Sydney" }],
    ["routine-run:morning:1", { status: "ok" }],
    ["routine-receipt:create", { status: "applied" }],
    ["routine-schedule:morning", { dueAt: 1 }],
    ["routine-key:morning", { digest: "secret" }],
    ["routine-inbox:1", { routineId: "morning" }],
    [
      "routine-account-timezone:v1",
      { schemaVersion: 1, revision: 4, timezone: "Australia/Sydney" },
    ],
  ]);
  const transaction = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async list({ prefix, limit = 128 }: { prefix: string; limit?: number }) {
      return new Map(
        [...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit),
      );
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
  return {
    values,
    storage: {
      async transaction(body: (tx: typeof transaction) => Promise<void>) {
        await body(transaction);
      },
    } as unknown as DurableObjectStorage,
  };
}

test("removes only obsolete Routine-owned state and is repeatable", async () => {
  const { values, storage } = fixture();
  await cleanRoutineTimezoneTestStateV1(storage);

  expect([...values.keys()].sort()).toEqual([
    "bot-configuration",
    "identity",
    "maintenance:routine-account-timezone:2026-09-10",
    "run:chat",
  ]);

  values.set("routine:new", { schedule: "0 9 * * *" });
  await cleanRoutineTimezoneTestStateV1(storage);
  expect(values.has("routine:new")).toBe(true);
});
