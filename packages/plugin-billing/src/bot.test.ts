import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { UsageOutboxV1, usageEntriesFromTurnV1 } from "./bot.js";

describe("usage projection", () => {
  test("prices one bounded entry from each model/usage event in the settled turn", () => {
    const events = [
      {
        type: "model/usage",
        seq: 4,
        timestamp: "2026-09-04T01:02:03.000Z",
        turn: 2,
        step: 1,
        requestId: "request-1",
        provider: "ollama-cloud",
        model: "glm-5.3-flash:cloud",
        modelBinding: { connectionId: "ollama-main" },
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 50,
        reasoningTokens: 5,
        latencyMs: 900,
        estimated: false,
      },
    ] as SessionEvent[];

    expect(
      usageEntriesFromTurnV1({
        botId: "bot-a",
        runId: "run-a",
        turn: 2,
        events,
      }),
    ).toEqual([
      expect.objectContaining({
        entryId: "bot-a:run-a:request-1",
        turnId: "run-a:2",
        bindingId: "ollama-main",
        inputTokens: 100,
        cachedInputTokens: 50,
        costMicros: 19,
        unknownPrice: false,
      }),
    ]);
  });

  test("keeps entries until an idempotent sink accepts them", async () => {
    const values = new Map<string, unknown>();
    const outbox = new UsageOutboxV1({
      get: (key) => Promise.resolve(values.get(key) as never),
      put: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => Promise.resolve(values.delete(key)),
    });
    const projected = usageEntriesFromTurnV1({
      botId: "bot-a",
      runId: "run-a",
      turn: 2,
      events: [
        {
          type: "model/usage",
          seq: 1,
          timestamp: "2026-09-04T01:02:03.000Z",
          turn: 2,
          step: 1,
          requestId: "request-1",
          provider: "foundation",
          model: "deterministic-v1",
          inputTokens: 10,
          outputTokens: 2,
          latencyMs: 1,
          estimated: true,
        },
      ] as SessionEvent[],
    });
    await outbox.append(projected);
    await expect(
      outbox.drain({ recordEntries: () => Promise.reject(new Error("away")) }),
    ).rejects.toThrow("away");
    expect(await outbox.state()).toMatchObject({ pending: 1 });
    const delivered: unknown[] = [];
    await outbox.drain({
      recordEntries: (entries) => {
        delivered.push(...entries);
        return Promise.resolve();
      },
    });
    expect(delivered).toHaveLength(1);
    expect(await outbox.state()).toMatchObject({ pending: 0 });
  });
});
