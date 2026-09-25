import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BILLING_PLAN,
  BillingLedger,
  DAILY_LIMIT_REASON_V1,
  type BillingStorage,
  type UsageAttributionV1,
  type UsageReservation,
} from "./ledger";
import {
  dailySpendV1,
  isSpendLimitScopeV1,
  localDayStartV1,
  readSpendingRowsV1,
  setSpendLimitV1,
  spendScopePausedV1,
  spendSpikeV1,
  spendingCreditV1,
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
        limitScope: "routine|bot-1|digest",
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

  test("mail reads as its own cause and its own trigger", () => {
    const { charge, report } = setup();
    charge("model:m", 90, {
      runId: "m",
      cause: { kind: "email", botId: "bot-1" },
    });
    expect(report().groups).toMatchObject([
      { key: "email|bot-1|", label: "Email to Research", chargeMicros: 90 },
    ]);
    expect(report({ groupBy: "trigger" }).groups).toMatchObject([
      { key: "email", label: "Email" },
    ]);
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
      stack: [40],
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

  test("the daily bars split out the five biggest groups and fold the rest into one", () => {
    const { charge, report } = setup();
    for (let k = 0; k < 7; k++)
      charge(`model:${k}`, 100 * (7 - k), {
        runId: `r${k}`,
        cause: { kind: "routine", botId: "bot-1", id: `routine-${k}` },
      });
    const view = report();
    expect(view.groups.map((g) => g.chargeMicros)).toEqual([
      700, 600, 500, 400, 300, 200, 100,
    ]);
    const today = view.days.find((d) => d.chargeMicros > 0)!;
    expect(today.stack).toEqual([700, 600, 500, 400, 300, 300]);
    expect(view.days.every((d) => d.stack.length === 6)).toBe(true);
  });

  test("a view says what it cost the period before, and what drove it", () => {
    const { charge, report } = setup();
    const digest = {
      kind: "routine" as const,
      botId: "bot-1",
      id: "digest",
      label: "Morning digest",
      trigger: "cron",
    };
    charge("model:now-1", 300, { runId: "a", cause: digest });
    charge("model:now-2", 100, { runId: "b", cause: digest });
    charge("model:now-3", 50, {
      runId: "c",
      cause: { kind: "chat", botId: "bot-1" },
    });
    charge(
      "model:before",
      120,
      { runId: "d", cause: digest },
      { at: NOW - 10 * 24 * HOUR },
    );
    const view = report({ groupBy: "bot" });
    expect(view.totalMicros).toBe(450);
    expect(view.previousTotalMicros).toBe(120);
    expect(view.topCause).toMatchObject({
      key: "routine|bot-1|digest",
      label: "Morning digest",
      detail: "Research",
      chargeMicros: 400,
      turns: 2,
    });
  });

  test("credit lasts as long as the last week's pace allows", () => {
    const DAY = 24 * HOUR;
    expect(spendingCreditV1(7_000_000, 1_000_000, NOW + 30 * DAY, NOW)).toEqual(
      {
        availableMicros: 7_000_000,
        dailyMicros: 1_000_000,
        runsOutAt: NOW + 7 * DAY,
        renewsAt: NOW + 30 * DAY,
      },
    );
    expect(spendingCreditV1(7_000_000, 0, null, NOW).runsOutAt).toBeNull();
    const { charge, db } = setup();
    charge(
      "model:w",
      700,
      { runId: "w", cause: { kind: "chat", botId: "bot-1" } },
      { at: NOW - 2 * DAY },
    );
    charge(
      "model:old",
      9_000,
      { runId: "o", cause: { kind: "chat", botId: "bot-1" } },
      { at: NOW - 9 * DAY },
    );
    expect(dailySpendV1(db.sql, NOW)).toBe(100);
  });

  test("a daily limit stops background work once reached, and never the person's own chat", () => {
    const { ledger, charge, db } = setup();
    const dayStart = NOW - 12 * HOUR;
    setSpendLimitV1(db.sql, "routine|bot-1|digest", 300);
    setSpendLimitV1(db.sql, "bot|bot-2", 200);
    const reserve = (
      id: string,
      attribution: UsageAttributionV1,
      botId = "bot-1",
    ) =>
      ledger.reserve(
        {
          id,
          kind: "model",
          maximumMicros: 500,
          botId,
          description: "work",
          pricingVersion: BILLING_PLAN.pricingVersion,
          attribution,
        },
        dayStart,
      );
    // Under the limit, the charge goes through, and the one that crosses it
    // completes.
    charge("model:a", 200, { runId: "f1", cause: digest });
    expect(reserve("model:b", { runId: "f2", cause: digest })).toMatchObject({
      created: true,
    });
    ledger.settle({
      id: "model:b",
      costMicros: 1,
      chargeMicros: 150,
      quantities: {},
    });
    // Reached: the next charge of that Routine is refused, in any Bot it asks.
    expect(() => reserve("model:c", { runId: "f3", cause: digest })).toThrow(
      DAILY_LIMIT_REASON_V1,
    );
    expect(() =>
      reserve("model:d", { runId: "a1", cause: digest }, "bot-2"),
    ).toThrow(DAILY_LIMIT_REASON_V1);
    // A retry of a charge already held is the same charge, never refused.
    expect(reserve("model:b", { runId: "f2", cause: digest })).toMatchObject({
      created: false,
    });
    // A limit is on today: yesterday's spend does not count toward it.
    expect(
      spendScopePausedV1(db.sql, "routine|bot-1|digest", NOW + 13 * HOUR),
    ).toBe(false);
    // A Bot's limit counts and stops its background work, never its chat.
    charge(
      "model:e",
      250,
      { runId: "c1", cause: { kind: "chat", botId: "bot-2" } },
      { botId: "bot-2" },
    );
    expect(spendScopePausedV1(db.sql, "bot|bot-2", dayStart)).toBe(false);
    charge(
      "model:e2",
      250,
      { runId: "m0", cause: { kind: "email", botId: "bot-2" } },
      { botId: "bot-2" },
    );
    expect(spendScopePausedV1(db.sql, "bot|bot-2", dayStart)).toBe(true);
    // A Plugin's own page is the person in front of it.
    expect(
      reserve(
        "model:p",
        {
          cause: { kind: "plugin", botId: "bot-2", id: "notes" },
          pluginId: "notes",
        },
        "bot-2",
      ),
    ).toMatchObject({ created: true });
    expect(
      reserve(
        "model:f",
        { runId: "c2", cause: { kind: "chat", botId: "bot-2" } },
        "bot-2",
      ),
    ).toMatchObject({ created: true });
    expect(() =>
      reserve(
        "model:g",
        { runId: "m1", cause: { kind: "email", botId: "bot-2" } },
        "bot-2",
      ),
    ).toThrow(DAILY_LIMIT_REASON_V1);
    // Without the person's day, nothing is held to a limit.
    expect(
      ledger.reserve({
        id: "model:h",
        kind: "model",
        maximumMicros: 50,
        botId: "bot-2",
        description: "work",
        pricingVersion: BILLING_PLAN.pricingVersion,
        attribution: { runId: "m2", cause: { kind: "email", botId: "bot-2" } },
      }),
    ).toMatchObject({ created: true });
  });

  test("the page shows each limit beside its row, and whether it is reached", () => {
    const { charge, db, report } = setup();
    setSpendLimitV1(db.sql, "routine|bot-1|digest", 300);
    charge("model:a", 400, { runId: "f1", cause: digest });
    const limits = new Map([
      ["routine|bot-1|digest", { dailyMicros: 300, todayMicros: 400 }],
    ]);
    const query = {
      ...spendWindowV1("7d", NOW, undefined),
      groupBy: "cause" as const,
      filters: {},
    };
    const view = spendingReportV1(
      query,
      readSpendingRowsV1(db.sql, query),
      { userId: "user-1", bots: { "bot-1": "Research" } },
      "UTC",
      null,
      limits,
    );
    expect(view.groups[0]).toMatchObject({
      limitScope: "routine|bot-1|digest",
      limit: { dailyMicros: 300, todayMicros: 400, reached: true },
    });
    expect(report({ groupBy: "bot" }).groups[0]).toMatchObject({
      limitScope: "bot|bot-1",
    });
    expect(report({ groupBy: "model" }).groups[0]).not.toHaveProperty(
      "limitScope",
    );
  });

  test("a new Routine has no usual yet, so it raises no spike", () => {
    const { charge, db } = setup();
    const dayStart = NOW - 12 * HOUR;
    charge(
      "model:y",
      100_000,
      { runId: "y", cause: digest },
      {
        at: dayStart - 24 * HOUR + HOUR,
      },
    );
    charge("model:t", 600_000, { runId: "t", cause: digest });
    expect(spendSpikeV1(db.sql, "routine|bot-1|digest", dayStart)).toBeNull();
    // With three days behind it, its usual is theirs, not a week's.
    for (const d of [2, 3])
      charge(
        `model:y${d}`,
        100_000,
        { runId: `y${d}`, cause: digest },
        {
          at: dayStart - d * 24 * HOUR + HOUR,
        },
      );
    expect(spendSpikeV1(db.sql, "routine|bot-1|digest", dayStart)).toEqual({
      todayMicros: 600_000,
      usualMicros: 100_000,
    });
  });

  test("a spike is three times the week's usual and at least fifty cents", () => {
    const { charge, db } = setup();
    const dayStart = NOW - 12 * HOUR;
    for (let d = 1; d <= 7; d++)
      charge(
        `model:w${d}`,
        200_000,
        { runId: `w${d}`, cause: digest },
        {
          at: dayStart - d * 24 * HOUR + HOUR,
        },
      );
    charge("model:t1", 500_000, { runId: "t1", cause: digest });
    expect(spendSpikeV1(db.sql, "routine|bot-1|digest", dayStart)).toBeNull();
    charge("model:t2", 200_000, { runId: "t2", cause: digest });
    expect(spendSpikeV1(db.sql, "routine|bot-1|digest", dayStart)).toEqual({
      todayMicros: 700_000,
      usualMicros: 200_000,
    });
    expect(spendSpikeV1(db.sql, "routine|bot-1|other", dayStart)).toBeNull();
  });

  test("a day starts at the person's own midnight", () => {
    // 12:00 UTC is 22:00 in Sydney (UTC+10 in September).
    expect(localDayStartV1(NOW, "Australia/Sydney")).toBe(NOW - 22 * HOUR);
    expect(localDayStartV1(NOW, "UTC")).toBe(NOW - 12 * HOUR);
    // Adelaide is half an hour off the hour.
    expect(localDayStartV1(NOW, "Australia/Adelaide")).toBe(NOW - 21.5 * HOUR);
    // On the day Sydney's clocks go forward (Oct 4 2026), 10:00 local is
    // nine hours after midnight, not ten.
    const tenAm = Date.UTC(2026, 9, 3, 23);
    expect(localDayStartV1(tenAm, "Australia/Sydney")).toBe(
      Date.UTC(2026, 9, 3, 14),
    );
    expect(isSpendLimitScopeV1("routine|bot-1|digest")).toBe(true);
    expect(isSpendLimitScopeV1("routine|bot-1|")).toBe(false);
    expect(isSpendLimitScopeV1("bot|bot-1")).toBe(true);
    expect(isSpendLimitScopeV1("chat|bot-1|")).toBe(false);
    expect(isSpendLimitScopeV1("bot|a|b")).toBe(false);
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
