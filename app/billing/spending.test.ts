import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BILLING_PLAN,
  BillingLedger,
  type BillingStorage,
  type UsageAttributionV1,
  type UsageReservation,
} from "./ledger";
import {
  readSpendingRowsV1,
  spendingReportV1,
  spendWindowV1,
  type SpendingQueryV1,
} from "./spending";

function storage(database = new Database(":memory:")): BillingStorage {
  return {
    sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        const rows = database.query(query).all(...bindings) as T[];
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return database.transaction(callback)();
    },
  };
}

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 20, 12);

const digest: UsageAttributionV1["cause"] = {
  kind: "routine",
  botId: "bot-1",
  id: "digest",
  label: "Morning digest",
  trigger: "cron",
};

function setup() {
  return setupOn(new Database(":memory:"));
}

function setupOn(database: Database) {
  const db = storage(database);
  let now = NOW;
  const ledger = new BillingLedger(db, () => now);
  ledger.grant("comp:1", "complimentary", 100_000_000, null);
  const charge = (
    id: string,
    micros: number,
    attribution: UsageAttributionV1 | undefined,
    options: {
      at?: number;
      kind?: UsageReservation["kind"];
      botId?: string;
      sessionId?: string;
      servedModel?: string;
    } = {},
  ) => {
    now = options.at ?? NOW;
    ledger.reserve({
      id,
      kind: options.kind ?? "model",
      maximumMicros: micros,
      botId: options.botId ?? "bot-1",
      sessionId: options.sessionId ?? "user-1:bot-1",
      description: "work",
      pricingVersion: BILLING_PLAN.pricingVersion,
      ...(attribution ? { attribution } : {}),
    });
    ledger.settle({
      id,
      costMicros: Math.floor(micros / 2),
      chargeMicros: micros,
      quantities: {},
      ...(options.servedModel ? { servedModel: options.servedModel } : {}),
    });
    now = NOW;
  };
  const query = (
    overrides: Partial<SpendingQueryV1> = {},
  ): SpendingQueryV1 => ({
    ...spendWindowV1("7d", NOW, undefined),
    groupBy: "cause",
    filters: {},
    ...overrides,
  });
  const report = (overrides: Partial<SpendingQueryV1> = {}) =>
    spendingReportV1(
      query(overrides),
      readSpendingRowsV1(db.sql, query(overrides)),
      { userId: "user-1", bots: { "bot-1": "Research", "bot-2": "Writer" } },
      "Australia/Sydney",
    );
  return { ledger, charge, report, db };
}

describe("the Spending rollups", () => {
  test("a Routine is charged for its own Turns and for the work they set going", () => {
    const { charge, report } = setup();
    charge(
      "model:a",
      300,
      { runId: "fire-1", cause: digest, model: "@frock/auto" },
      {
        sessionId: "routine:digest",
        servedModel: "together/deepseek",
      },
    );
    charge(
      "search:b",
      10,
      { runId: "fire-1", cause: digest },
      {
        kind: "search",
        sessionId: "routine:digest",
      },
    );
    // Another Bot answered the firing's question, under the firing's cause.
    charge(
      "model:c",
      200,
      { runId: "agent-1", cause: digest, model: "@frock/auto" },
      {
        botId: "bot-2",
        sessionId: "user-1:bot-2",
      },
    );
    charge("model:d", 50, {
      runId: "chat-1",
      cause: { kind: "chat", botId: "bot-1" },
      model: "@frock/auto",
    });

    const byCause = report();
    expect(byCause.totalMicros).toBe(560);
    expect(byCause.turns).toBe(3);
    expect(byCause.groups).toEqual([
      {
        key: "routine|bot-1|digest",
        label: "Morning digest",
        detail: "Research",
        chargeMicros: 510,
        operations: 3,
        turns: 2,
      },
      {
        key: "chat|bot-1|",
        label: "Chat with Research",
        chargeMicros: 50,
        operations: 1,
        turns: 1,
      },
    ]);

    const byBot = report({
      groupBy: "bot",
      filters: { cause: "routine|bot-1|digest" },
    });
    expect(byBot.filters).toEqual([
      {
        dimension: "cause",
        value: "routine|bot-1|digest",
        label: "Morning digest",
      },
    ]);
    expect(byBot.groups.map((g) => [g.label, g.chargeMicros])).toEqual([
      ["Research", 310],
      ["Writer", 200],
    ]);
    expect(byBot.topTurns?.map((t) => [t.runId, t.chargeMicros])).toEqual([
      ["fire-1", 310],
      ["agent-1", 200],
    ]);

    const byCategory = report({ groupBy: "category" });
    expect(byCategory.groups.map((g) => [g.label, g.chargeMicros])).toEqual([
      ["Model replies", 550],
      ["Web search", 10],
    ]);
    // A Turn spans categories, so they count no Turns.
    expect(byCategory.groups[0]).not.toHaveProperty("turns");

    const byModel = report({ groupBy: "model" });
    expect(byModel.groups.map((g) => g.key).sort()).toEqual([
      "",
      "@frock/auto",
      "together/deepseek",
    ]);
    // Filtered to a model, no single Turn's total is honest.
    expect(report({ filters: { model: "@frock/auto" } }).topTurns).toBeNull();

    expect(report({ groupBy: "trigger" }).groups.map((g) => g.label)).toEqual([
      "Schedule",
      "You",
    ]);
    expect(
      report({ groupBy: "conversation" }).groups.map((g) => [
        g.label,
        g.detail,
      ]),
    ).toEqual([
      ["Morning digest", "Research"],
      ["Chat with Writer", undefined],
      ["Chat with Research", undefined],
    ]);
  });

  test("a settlement is rolled up once, and a zero charge not at all", () => {
    const { ledger, charge, report } = setup();
    charge("model:a", 100, {
      runId: "r",
      cause: { kind: "chat", botId: "bot-1" },
    });
    ledger.settle({
      id: "model:a",
      costMicros: 50,
      chargeMicros: 100,
      quantities: {},
    });
    charge("model:b", 0, {
      runId: "r2",
      cause: { kind: "chat", botId: "bot-1" },
    });
    const byCause = report();
    expect(byCause.totalMicros).toBe(100);
    expect(byCause.operations).toBe(1);
    expect(byCause.turns).toBe(1);
  });

  test("attribution is not part of a charge's identity, and a rename is read by its new name", () => {
    const { ledger, report } = setup();
    const reservation = {
      id: "model:x",
      kind: "model" as const,
      maximumMicros: 100,
      botId: "bot-1",
      description: "work",
      pricingVersion: BILLING_PLAN.pricingVersion,
    };
    ledger.reserve({
      ...reservation,
      attribution: { runId: "r", cause: digest },
    });
    expect(
      ledger.reserve({
        ...reservation,
        attribution: { runId: "r", cause: { ...digest!, label: "Digest v2" } },
      }),
    ).toEqual({ status: "reserved", created: false });
    ledger.reserve({
      ...reservation,
      id: "model:y",
      attribution: { runId: "r", cause: { ...digest!, label: "Digest v2" } },
    });
    ledger.settle({
      id: "model:x",
      costMicros: 1,
      chargeMicros: 100,
      quantities: {},
    });
    expect(report().groups[0]?.label).toBe("Digest v2");
  });

  test("a malformed attribution is recorded as unattributed, never refused", () => {
    const { charge, report } = setup();
    charge("model:a", 70, {
      runId: "r",
      cause: { kind: "nonsense" as never, botId: "bot-1" },
    });
    charge("computer:b", 30, undefined, { kind: "computer" });
    expect(report().groups).toEqual([
      {
        key: "||",
        label: "Not attributed",
        chargeMicros: 100,
        operations: 2,
        turns: 1,
      },
    ]);
  });

  test("days are the person's own, and the window only reads its hours", () => {
    const { charge, report } = setup();
    // 23:30 UTC on the 19th is the 20th in Sydney.
    const late = Date.UTC(2026, 8, 19, 23, 30);
    charge(
      "model:a",
      40,
      { runId: "r", cause: { kind: "chat", botId: "bot-1" } },
      { at: late },
    );
    charge(
      "model:old",
      99,
      { runId: "o", cause: { kind: "chat", botId: "bot-1" } },
      {
        at: NOW - 30 * 24 * HOUR,
      },
    );
    const view = report();
    expect(view.totalMicros).toBe(40);
    expect(view.days.find((d) => d.chargeMicros > 0)).toEqual({
      day: "2026-09-20",
      chargeMicros: 40,
    });
    expect(view.days.length).toBeGreaterThanOrEqual(7);
  });

  test("a rollup that fails leaves a gap, never an unsettled charge", () => {
    const database = new Database(":memory:");
    const { ledger } = setupOn(database);
    ledger.reserve({
      id: "model:z",
      kind: "model",
      maximumMicros: 100,
      description: "work",
      pricingVersion: BILLING_PLAN.pricingVersion,
    });
    database.run("DROP TABLE billing_spend_hourly");
    ledger.settle({
      id: "model:z",
      costMicros: 1,
      chargeMicros: 100,
      quantities: {},
    });
    expect(
      database
        .query("SELECT status FROM billing_operations WHERE id = 'model:z'")
        .get(),
    ).toEqual({ status: "settled" });
  });

  test("a Plugin's call is never a conversation summary, and a Turn is timed from its earliest charge", () => {
    const { charge, report } = setup();
    const chat = { kind: "chat" as const, botId: "bot-1" };
    charge("model:p", 20, {
      runId: "r",
      cause: chat,
      summary: true,
      pluginId: "notes",
    });
    charge(
      "model:s",
      30,
      { runId: "r", cause: chat, summary: true },
      { at: NOW - 2 * HOUR },
    );
    expect(
      report({ groupBy: "category" }).groups.map((g) => [
        g.key,
        g.chargeMicros,
      ]),
    ).toEqual([
      ["summary", 30],
      ["model", 20],
    ]);
    const window = spendWindowV1("7d", NOW, undefined);
    expect(
      report({ since: NOW - 90 * 60_000, until: window.until }).topTurns,
    ).toEqual([]);
    expect(report().topTurns?.[0]).toMatchObject({
      runId: "r",
      at: NOW - 2 * HOUR,
    });
  });

  test("the billing period starts where paid access did", () => {
    expect(spendWindowV1("billing", NOW, NOW - 5 * 24 * HOUR).since).toBe(
      NOW - 5 * 24 * HOUR,
    );
    expect(spendWindowV1("billing", NOW, undefined).since).toBeLessThan(
      NOW - 29 * 24 * HOUR,
    );
  });
});
