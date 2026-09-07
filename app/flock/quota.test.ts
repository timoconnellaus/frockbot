import { describe, expect, test } from "bun:test";
import {
  AGENT_TURN_CONCURRENCY_PER_USER_V1,
  releaseAgentTurnSlotV1,
  reserveAgentTurnSlotV1,
  type AgentTurnSlotTransactionV1,
} from "./quota.js";

function storage() {
  const records = new Map<string, unknown>();
  const transaction: AgentTurnSlotTransactionV1 = {
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...records].filter(([key]) => key.startsWith(prefix))) as Map<
        string,
        T
      >,
    put: async (key, value) => void records.set(key, value),
    delete: async (key) => records.delete(key),
  };
  return {
    ...transaction,
    transaction: async <T>(
      callback: (tx: AgentTurnSlotTransactionV1) => Promise<T>,
    ) => callback(transaction),
  };
}

function request(requesterId: string, runId: string) {
  return {
    schemaVersion: 1 as const,
    userId: "user",
    requesterId,
    runId,
    reservedAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("agent Turn concurrency", () => {
  test("is one fixed per-User budget across requesting Bots", async () => {
    const state = storage();
    for (
      let index = 0;
      index < AGENT_TURN_CONCURRENCY_PER_USER_V1;
      index += 1
    ) {
      expect(
        await reserveAgentTurnSlotV1(
          state,
          request(index % 2 ? "bot-a" : "bot-b", `run-${index}`),
        ),
      ).toMatchObject({ status: "reserved" });
    }
    expect(
      await reserveAgentTurnSlotV1(state, request("bot-c", "run-past")),
    ).toMatchObject({ status: "refused", held: 8, limit: 8 });
  });

  test("reserve and release are idempotent for one run", async () => {
    const state = storage();
    await reserveAgentTurnSlotV1(state, request("bot-a", "run-1"));
    expect(
      await reserveAgentTurnSlotV1(state, request("bot-a", "run-1")),
    ).toMatchObject({ status: "reserved", held: 1 });
    expect(
      await releaseAgentTurnSlotV1(state, {
        requesterId: "bot-a",
        runId: "run-1",
      }),
    ).toMatchObject({ held: 0 });
  });
});
