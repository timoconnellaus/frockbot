import { expect, test } from "bun:test";
import { cleanIncidentTestChatsV1 } from "./test-chat-cleanup.js";

function fixture(
  botId = "bob-daff7ee3",
  userId = "vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG",
) {
  const values = new Map<string, unknown>([
    ["identity", { botId, userId }],
    ["bot-settings", { name: "Bob" }],
    ["composition:current", "generation"],
    ["workspace:generation:memory", "memory"],
    ["routine:morning", { enabled: true }],
    ["run:old", { status: "completed" }],
    ["latest-events", [{ type: "model/reconciliation-required" }]],
    ["session-events:payload:old:0", "old payload"],
    ["shell:preview", { text: "old" }],
  ]);
  const tx = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async list({
      prefix,
      limit = 1000,
      startAfter,
    }: {
      prefix: string;
      limit?: number;
      startAfter?: string;
    }) {
      return new Map(
        [...values]
          .filter(
            ([key]) =>
              key.startsWith(prefix) && (!startAfter || key > startAfter),
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      );
    },
    async delete(keys: string[]) {
      let count = 0;
      for (const key of keys) if (values.delete(key)) count++;
      return count;
    },
  };
  const storage = {
    async transaction(body: (tx: unknown) => Promise<void>) {
      const before = new Map(values);
      try {
        await body(tx);
      } catch (error) {
        values.clear();
        for (const [k, v] of before) values.set(k, v);
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { values, storage };
}

test("only the authorized test Bots are cleaned, without decoding retired event types", async () => {
  for (const bot of [
    "bob-daff7ee3",
    "native-qa-20260905",
    "test-n5jJuqCi",
    "test-99860758",
  ]) {
    const { values, storage } = fixture(bot);
    await cleanIncidentTestChatsV1(storage);
    expect(values.has("run:old")).toBe(false);
    expect(values.has("latest-events")).toBe(false);
    expect(values.has("session-events:payload:old:0")).toBe(false);
    expect(values.has("shell:preview")).toBe(false);
    for (const key of [
      "identity",
      "bot-settings",
      "composition:current",
      "workspace:generation:memory",
      "routine:morning",
    ])
      expect(values.has(key)).toBe(true);
    values.set("run:new", { status: "completed" });
    await cleanIncidentTestChatsV1(storage);
    expect(values.has("run:new")).toBe(true);
  }
});

test("other Bots and other Users are untouched", async () => {
  for (const args of [["other-bot"], ["bob-daff7ee3", "other-user"]]) {
    const { values, storage } = fixture(...args);
    const before = new Map(values);
    await cleanIncidentTestChatsV1(storage);
    expect(values).toEqual(before);
  }
});

test("active work on a later page prevents any deletion", async () => {
  const { values, storage } = fixture();
  for (let i = 0; i < 70; i++)
    values.set(`run:${String(i).padStart(3, "0")}`, {
      status: i === 69 ? "running" : "completed",
    });
  const before = new Map(values);
  await cleanIncidentTestChatsV1(storage);
  expect(values).toEqual(before);
});
