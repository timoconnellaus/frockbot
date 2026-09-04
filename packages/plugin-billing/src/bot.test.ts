import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { UsageOutboxV1, usageEntriesFromTurnV1 } from "./bot.js";
import type { UsageEntryV1 } from "./shared.js";

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
      {
        type: "turn/end",
        seq: 5,
        timestamp: "2026-09-04T01:02:04.000Z",
        turn: 2,
        outcome: "completed",
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
        {
          type: "turn/end",
          seq: 2,
          timestamp: "2026-09-04T01:02:04.000Z",
          turn: 2,
          outcome: "completed",
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

  test("does not project an open Turn and preserves concurrent appends during delivery", async () => {
    expect(
      usageEntriesFromTurnV1({
        botId: "bot-a",
        runId: "run-open",
        turn: 1,
        events: [
          {
            type: "model/usage",
            seq: 1,
            timestamp: "2026-09-04T01:02:03.000Z",
            turn: 1,
            step: 1,
            requestId: "open-request",
            provider: "foundation",
            model: "deterministic-v1",
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            estimated: true,
          },
        ] as SessionEvent[],
      }),
    ).toEqual([]);

    const values = new Map<string, unknown>();
    const outbox = new UsageOutboxV1({
      get: (key) => Promise.resolve(values.get(key) as never),
      put: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => Promise.resolve(values.delete(key)),
    });
    const first = {
      schemaVersion: 1,
      entryId: "first",
      kind: "model",
      at: "2026-09-04T01:02:03.000Z",
      provider: "foundation",
      model: "deterministic-v1",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      voiceSeconds: 0,
      latencyMs: 1,
      estimated: false,
      unknownPrice: false,
      priceTableVersion: "test",
      costMicros: 0,
    } satisfies UsageEntryV1;
    const second = { ...first, entryId: "second" };
    await outbox.append([first]);
    await outbox.drain({
      recordEntries: async () => {
        await outbox.append([second]);
      },
    });
    expect(await outbox.state()).toEqual({ pending: 1, truncated: false });
    const delivered: string[] = [];
    await outbox.drain({
      recordEntries: (entries) => {
        delivered.push(...entries.map((entry) => entry.entryId));
        return Promise.resolve();
      },
    });
    expect(delivered).toEqual(["second"]);
  });
});
