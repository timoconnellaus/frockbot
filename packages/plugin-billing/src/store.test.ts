import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { UsageEntryV1 } from "./shared.js";
import { UsageStoreV1, type UsageSqlV1 } from "./store.js";

function sqlV1(database: Database): UsageSqlV1 {
  return {
    exec(query, ...bindings) {
      const statement = database.query(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => statement.all(...bindings) as never[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function entry(
  entryId: string,
  at: string,
  overrides: Partial<UsageEntryV1> = {},
): UsageEntryV1 {
  return {
    schemaVersion: 1,
    entryId,
    kind: "model",
    botId: "bot-a",
    runId: `run-${entryId}`,
    turnId: `run-${entryId}:1`,
    turn: 1,
    requestId: `request-${entryId}`,
    at,
    provider: "flock-ai",
    model: "@frock/deepseek-ai/deepseek-v4-flash-0731",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    reasoningTokens: 5,
    voiceSeconds: 0,
    latencyMs: 300,
    estimated: false,
    unknownPrice: false,
    priceTableVersion: "test",
    costMicros: 70,
    ...overrides,
  };
}

describe("UsageStoreV1", () => {
  test("deduplicates entries and builds monthly, daily, bot and model totals", () => {
    const database = new Database(":memory:");
    const store = new UsageStoreV1({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });
    const first = entry("one", "2026-09-03T10:00:00.000Z");
    const second = entry("two", "2026-09-04T10:00:00.000Z", {
      botId: "bot-b",
      inputTokens: 50,
      outputTokens: 10,
      costMicros: 30,
      estimated: true,
      unknownPrice: true,
    });

    expect(store.record([first, second, first])).toBe(2);
    const report = store.report(new Date("2026-09-04T12:00:00.000Z"));

    expect(report).toMatchObject({
      currentMonthCostMicros: 100,
      lifetimeCostMicros: 100,
      currentMonthInputTokens: 150,
      currentMonthOutputTokens: 30,
      estimatedCalls: 1,
      unknownPriceCalls: 1,
    });
    expect(report.bots).toEqual([
      expect.objectContaining({ id: "bot-a", costMicros: 70 }),
      expect.objectContaining({ id: "bot-b", costMicros: 30 }),
    ]);
    expect(report.models).toEqual([
      expect.objectContaining({
        id: "flock-ai/@frock/deepseek-ai/deepseek-v4-flash-0731",
        costMicros: 100,
      }),
    ]);
    expect(report.days.slice(-2)).toEqual([
      { day: "2026-09-03", costMicros: 70 },
      { day: "2026-09-04", costMicros: 30 },
    ]);
    database.close();
  });

  test("removes old detail and daily rows while preserving monthly and lifetime totals", () => {
    const database = new Database(":memory:");
    const store = new UsageStoreV1({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
      detailRetentionDays: 5,
    });
    store.record([entry("old", "2026-08-20T10:00:00.000Z")]);

    expect(
      database.query("SELECT count(*) AS n FROM usage_entries").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
    expect(store.report(new Date("2026-08-25T00:00:00.000Z"))).toMatchObject({
      currentMonthCostMicros: 70,
      lifetimeCostMicros: 70,
    });
    database.close();
  });
});
