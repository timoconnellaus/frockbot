import { describe, expect, test } from "bun:test";
import {
  decodeSubagentSlotReceiptV1,
  releaseSubagentSlotV1,
  reserveSubagentSlotV1,
  SUBAGENT_SLOT_LIMIT_V1,
} from "./quota.js";
import { createMemorySubagentStorageV1 } from "./testing.js";

function request(botId: string, taskId: string) {
  return {
    schemaVersion: 1 as const,
    userId: "user",
    botId,
    taskId,
    reservedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("the per-User concurrent-subagent bound", () => {
  test("admits up to the bound and refuses the one past it", async () => {
    const storage = createMemorySubagentStorageV1();
    for (let index = 0; index < SUBAGENT_SLOT_LIMIT_V1; index += 1) {
      expect(
        await reserveSubagentSlotV1(storage, request("bot", `tk-${index}`)),
      ).toMatchObject({ status: "reserved" });
    }
    const refused = await reserveSubagentSlotV1(
      storage,
      request("bot", "tk-past"),
    );
    expect(refused).toMatchObject({ status: "refused", held: 8, limit: 8 });
    expect(refused.status === "refused" && refused.reason).toContain(
      "the bound is 8",
    );
  });

  test("counts across a User's Bots, which is the whole reason it lives here", async () => {
    const storage = createMemorySubagentStorageV1();
    for (let index = 0; index < 4; index += 1) {
      await reserveSubagentSlotV1(storage, request("bot-a", `tk-${index}`));
    }
    for (let index = 0; index < 4; index += 1) {
      await reserveSubagentSlotV1(storage, request("bot-b", `tk-${index}`));
    }
    expect(
      await reserveSubagentSlotV1(storage, request("bot-c", "tk-0")),
    ).toMatchObject({ status: "refused" });
  });

  test("is idempotent per task: a resumed dispatch takes no second slot", async () => {
    const storage = createMemorySubagentStorageV1();
    await reserveSubagentSlotV1(storage, request("bot", "tk-1"));
    const again = await reserveSubagentSlotV1(storage, request("bot", "tk-1"));
    expect(again).toMatchObject({ status: "reserved", held: 1 });
  });

  test("a release gives the slot back, and releasing twice is a no-op", async () => {
    const storage = createMemorySubagentStorageV1();
    await reserveSubagentSlotV1(storage, request("bot", "tk-1"));
    expect(
      await releaseSubagentSlotV1(storage, { botId: "bot", taskId: "tk-1" }),
    ).toMatchObject({ held: 0 });
    expect(
      await releaseSubagentSlotV1(storage, { botId: "bot", taskId: "tk-1" }),
    ).toMatchObject({ held: 0 });
  });
});

describe("the receipt that crosses the Durable Object seam", () => {
  test("decodes both statuses and refuses anything else", async () => {
    const storage = createMemorySubagentStorageV1();
    const reserved = await reserveSubagentSlotV1(
      storage,
      request("bot", "tk-1"),
    );
    expect(decodeSubagentSlotReceiptV1(reserved)).toEqual(reserved);
    expect(() =>
      decodeSubagentSlotReceiptV1({ ...reserved, status: "maybe" }),
    ).toThrow(/status is invalid/);
  });
});
