import { expect, test } from "bun:test";
import {
  cleanBotAvatarTestState,
  cleanUserAvatarTestState,
} from "./avatar-state-cleanup.js";

function fixture(entries: [string, unknown][]) {
  const values = new Map(entries);
  const tx = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) {
      return new Map(
        [...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit),
      );
    },
    async delete(keys: string | string[]) {
      if (typeof keys === "string") return values.delete(keys);
      let count = 0;
      for (const key of keys) if (values.delete(key)) count++;
      return count;
    },
  };
  const storage = {
    async transaction(body: (storage: unknown) => Promise<void>) {
      await body(tx);
    },
  } as unknown as DurableObjectStorage;
  return { values, storage };
}

test("avatar cleanup keeps registrations and replaces only layered appearances", async () => {
  const current = {
    schemaVersion: 1,
    characterId: "dog",
    primary: "#dca258",
  };
  const { values, storage } = fixture([
    [
      "flock:directory:v1",
      {
        schemaVersion: 1,
        revision: 7,
        bots: [
          {
            schemaVersion: 1,
            botId: "old",
            registeredAt: "2026-09-05T00:00:00.000Z",
            initialName: "Old",
            sheep: {
              schemaVersion: 1,
              background: "hot-pink",
              upper: "upper-neutral",
              middle: "middle-neutral",
              lower: "lower-neutral",
            },
          },
          {
            schemaVersion: 1,
            botId: "current",
            registeredAt: "2026-09-05T00:00:00.000Z",
            initialName: "Current",
            avatar: current,
          },
        ],
      },
    ],
    ["flock:create-receipt:old", { fingerprint: "old" }],
    ["unrelated", "kept"],
  ]);

  await cleanUserAvatarTestState(storage);
  const directory = values.get("flock:directory:v1") as {
    revision: number;
    bots: { avatar: unknown }[];
  };
  expect(directory.revision).toBe(7);
  expect(directory.bots).toHaveLength(2);
  expect(directory.bots[0]?.avatar).toEqual({
    schemaVersion: 1,
    characterId: "pixel",
    primary: "#fc85ae",
  });
  expect(directory.bots[0]).not.toHaveProperty("sheep");
  expect(directory.bots[1]?.avatar).toEqual(current);
  expect(values.has("flock:create-receipt:old")).toBe(false);
  expect(values.get("unrelated")).toBe("kept");

  values.set("flock:create-receipt:new", { fingerprint: "new" });
  await cleanUserAvatarTestState(storage);
  expect(values.has("flock:create-receipt:new")).toBe(true);
});

test("Bot cleanup removes the retired identity without touching conversation state", async () => {
  const { values, storage } = fixture([
    ["flock:sheep:v1", { old: true }],
    ["flock:sheep-receipt:one", { old: true }],
    ["run:conversation", { status: "completed" }],
  ]);
  await cleanBotAvatarTestState(storage);
  expect(values.has("flock:sheep:v1")).toBe(false);
  expect(values.has("flock:sheep-receipt:one")).toBe(false);
  expect(values.get("run:conversation")).toEqual({ status: "completed" });
});
