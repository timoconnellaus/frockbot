// Where an account's credit went, kept ready to read.
//
// Every charge records why it was made beside it (`billing_attribution`),
// and every settlement adds itself, in the same transaction, to an hourly
// rollup and to its Turn's running total. The Spending page reads only those
// two: it never scans the operation log, however long the account has run.
//
// Hours rather than days, because a day is the person's own and their
// timezone is not the ledger's to know: the rollup is summed into their days
// when it is read.
import { groupIdOfSessionV1 } from "@frockbot/app/groups/shared";
import { routineIdOfSessionV1 } from "@frockbot/app/routines/firing";
import {
  SPEND_CAUSE_KINDS_V1,
  type BillingSql,
  type SpendCategoryV1,
  type UsageAttributionV1,
  type UsageReservation,
  type UsageSettlement,
} from "./ledger.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The ways the Spending page slices an account's charges. */
export type SpendDimensionV1 =
  | "bot"
  | "cause"
  | "trigger"
  | "conversation"
  | "category"
  | "model"
  | "plugin";
export const SPEND_DIMENSIONS_V1: readonly SpendDimensionV1[] = [
  "bot",
  "cause",
  "trigger",
  "conversation",
  "category",
  "model",
  "plugin",
];

// Each dimension's key, as one SQL expression over a rollup row. A Turn has
// exactly one value of each of the first four, which is what lets a grouping
// by them count Turns and list the most expensive ones.
const DIMENSION_SQL: Record<SpendDimensionV1, string> = {
  bot: "bot_id",
  cause: "cause_kind || '|' || cause_bot_id || '|' || cause_id",
  trigger: "trigger",
  conversation: "bot_id || '|' || session_id",
  category: "category",
  model: "model",
  plugin: "plugin_id",
};
const TURN_DIMENSIONS: ReadonlySet<SpendDimensionV1> = new Set([
  "bot",
  "cause",
  "trigger",
  "conversation",
]);

export function createSpendingTablesV1(sql: BillingSql) {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS billing_attribution (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, cause_kind TEXT NOT NULL, cause_bot_id TEXT NOT NULL, cause_id TEXT NOT NULL, trigger TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL, plugin_id TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS billing_spend_hourly (hour INTEGER NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, cause_kind TEXT NOT NULL, cause_bot_id TEXT NOT NULL, cause_id TEXT NOT NULL, trigger TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL, plugin_id TEXT NOT NULL, charge INTEGER NOT NULL, operations INTEGER NOT NULL, turns INTEGER NOT NULL, PRIMARY KEY (hour, bot_id, session_id, cause_kind, cause_bot_id, cause_id, trigger, category, model, plugin_id)) WITHOUT ROWID`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS billing_spend_runs (run_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, cause_kind TEXT NOT NULL, cause_bot_id TEXT NOT NULL, cause_id TEXT NOT NULL, trigger TEXT NOT NULL, first INTEGER NOT NULL, charge INTEGER NOT NULL, operations INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS billing_spend_runs_first ON billing_spend_runs(first)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS billing_spend_labels (key TEXT PRIMARY KEY, label TEXT NOT NULL)`,
  );
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

interface AttributionRow {
  runId: string;
  causeKind: string;
  causeBotId: string;
  causeId: string;
  trigger: string;
  category: SpendCategoryV1;
  model: string;
  pluginId: string;
  label?: string;
}

/**
 * The row one reservation's attribution becomes. Anything malformed is left
 * out rather than refused: attribution never stops a paid call.
 */
export function attributionRowV1(
  reservation: Pick<UsageReservation, "kind" | "botId">,
  attribution: UsageAttributionV1 | undefined,
): AttributionRow {
  const cause = attribution?.cause;
  const kind = SPEND_CAUSE_KINDS_V1.find((k) => k === cause?.kind);
  const causeBotId = kind ? (text(cause?.botId, 128) ?? "") : "";
  const causeId = kind ? (text(cause?.id, 256) ?? "") : "";
  return {
    runId: text(attribution?.runId, 256) ?? "",
    causeKind: kind ?? "",
    // A Group Chat is one cause whichever member ran the Turn.
    causeBotId: kind === "group" ? "" : causeBotId,
    causeId,
    trigger: kind
      ? kind === "routine"
        ? (text(cause?.trigger, 32) ?? "")
        : kind === "plugin" || kind === "email"
          ? kind
          : "person"
      : "",
    category:
      reservation.kind === "model"
        ? attribution?.summary && !attribution.pluginId
          ? "summary"
          : "model"
        : reservation.kind,
    model: text(attribution?.model, 300) ?? "",
    pluginId: text(attribution?.pluginId, 128) ?? "",
    ...(kind && causeId && text(cause?.label, 300)
      ? { label: cause!.label }
      : {}),
  };
}

export function causeKeyV1(row: {
  causeKind: string;
  causeBotId: string;
  causeId: string;
}) {
  return `${row.causeKind}|${row.causeBotId}|${row.causeId}`;
}

export function recordAttributionV1(
  sql: BillingSql,
  reservation: UsageReservation,
  attribution: UsageAttributionV1 | undefined,
) {
  const row = attributionRowV1(reservation, attribution);
  sql.exec(
    "INSERT OR IGNORE INTO billing_attribution VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    reservation.id,
    row.runId,
    row.causeKind,
    row.causeBotId,
    row.causeId,
    row.trigger,
    row.category,
    row.model,
    row.pluginId,
  );
  // The newest name wins: a renamed Routine reads by its current name.
  if (row.label)
    sql.exec(
      "INSERT INTO billing_spend_labels(key, label) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET label = excluded.label",
      causeKeyV1(row),
      row.label,
    );
}

interface SettledOperation extends Record<string, string | number | null> {
  kind: string;
  botId: string | null;
  sessionId: string | null;
  created: number;
  runId: string | null;
  causeKind: string | null;
  causeBotId: string | null;
  causeId: string | null;
  trigger: string | null;
  category: string | null;
  model: string | null;
  pluginId: string | null;
}

/**
 * Add one settlement to the rollups. Called inside the settlement's own
 * transaction, once: a settlement that repeats returns before it gets here.
 */
export function rollUpSettlementV1(
  sql: BillingSql,
  settlement: UsageSettlement,
) {
  if (settlement.chargeMicros <= 0) return;
  const op = sql
    .exec<SettledOperation>(
      "SELECT o.kind AS kind, o.bot_id AS botId, o.session_id AS sessionId, o.created AS created, a.run_id AS runId, a.cause_kind AS causeKind, a.cause_bot_id AS causeBotId, a.cause_id AS causeId, a.trigger AS trigger, a.category AS category, a.model AS model, a.plugin_id AS pluginId FROM billing_operations o LEFT JOIN billing_attribution a ON a.operation_id = o.id WHERE o.id = ?",
      settlement.id,
    )
    .toArray()[0];
  if (!op) return;
  const charge = settlement.chargeMicros;
  const botId = op.botId ?? "";
  const sessionId = op.sessionId ?? "";
  const causeKind = op.causeKind ?? "";
  const causeBotId = op.causeBotId ?? "";
  const causeId = op.causeId ?? "";
  const trigger = op.trigger ?? "";
  let turns = 0;
  if (op.runId) {
    const known = sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM billing_spend_runs WHERE run_id = ?",
        op.runId,
      )
      .toArray().length;
    if (known)
      sql.exec(
        "UPDATE billing_spend_runs SET charge = charge + ?, operations = operations + 1, first = MIN(first, ?) WHERE run_id = ?",
        charge,
        op.created,
        op.runId,
      );
    else {
      turns = 1;
      sql.exec(
        "INSERT INTO billing_spend_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        op.runId,
        botId,
        sessionId,
        causeKind,
        causeBotId,
        causeId,
        trigger,
        op.created,
        charge,
      );
    }
  }
  sql.exec(
    "INSERT INTO billing_spend_hourly VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO UPDATE SET charge = charge + excluded.charge, operations = operations + 1, turns = turns + excluded.turns",
    Math.floor(op.created / HOUR_MS),
    botId,
    sessionId,
    causeKind,
    causeBotId,
    causeId,
    trigger,
    op.category ?? op.kind,
    settlement.servedModel ?? op.model ?? "",
    op.pluginId ?? "",
    charge,
    turns,
  );
}

/** What the account has been charged since `since`, from the rollup. */
export function spentSinceV1(sql: BillingSql, since: number): number {
  return (
    sql
      .exec<{ micros: number }>(
        "SELECT COALESCE(SUM(charge), 0) AS micros FROM billing_spend_hourly WHERE hour >= ?",
        Math.floor(since / HOUR_MS),
      )
      .toArray()[0]?.micros ?? 0
  );
}

export interface SpendingQueryV1 {
  since: number;
  until: number;
  groupBy: SpendDimensionV1;
  filters: Partial<Record<SpendDimensionV1, string>>;
}

export interface SpendingRowsV1 {
  hours: {
    hour: number;
    key: string;
    charge: number;
    operations: number;
    turns: number;
  }[];
  topTurns:
    | {
        runId: string;
        botId: string;
        sessionId: string;
        causeKey: string;
        trigger: string;
        first: number;
        charge: number;
        operations: number;
      }[]
    | null;
  labels: Record<string, string>;
  /** What the same view cost over the window just before this one. */
  previousTotal: number;
  /** The cause that spent the most in this view. */
  topCause: { key: string; charge: number; turns: number } | null;
}

function where(
  query: SpendingQueryV1,
  since: string,
): { clause: string; bindings: (string | number)[] } {
  const clauses = [`${since} >= ?`, `${since} < ?`];
  const bindings: (string | number)[] = [];
  for (const dimension of SPEND_DIMENSIONS_V1) {
    const value = query.filters[dimension];
    if (value === undefined) continue;
    clauses.push(`(${DIMENSION_SQL[dimension]}) = ?`);
    bindings.push(value);
  }
  return { clause: clauses.join(" AND "), bindings };
}

/** The rollup rows one Spending view needs. Bounded by its period. */
export function readSpendingRowsV1(
  sql: BillingSql,
  query: SpendingQueryV1,
): SpendingRowsV1 {
  const hourly = where(query, "hour");
  const hours = sql
    .exec<{
      hour: number;
      key: string;
      charge: number;
      operations: number;
      turns: number;
    }>(
      `SELECT hour, (${DIMENSION_SQL[query.groupBy]}) AS key, SUM(charge) AS charge, SUM(operations) AS operations, SUM(turns) AS turns FROM billing_spend_hourly WHERE ${hourly.clause} GROUP BY hour, key`,
      Math.floor(query.since / HOUR_MS),
      Math.ceil(query.until / HOUR_MS),
      ...hourly.bindings,
    )
    .toArray();
  // A Turn has one Bot, cause, trigger and conversation, but spans several
  // categories, models and Plugins: filtered by one of those, "the most
  // expensive Turns" has no honest answer.
  const turnLevel = SPEND_DIMENSIONS_V1.every(
    (d) => query.filters[d] === undefined || TURN_DIMENSIONS.has(d),
  );
  let topTurns: SpendingRowsV1["topTurns"] = null;
  if (turnLevel) {
    const runs = where(query, "first");
    topTurns = sql
      .exec<{
        runId: string;
        botId: string;
        sessionId: string;
        causeKey: string;
        trigger: string;
        first: number;
        charge: number;
        operations: number;
      }>(
        `SELECT run_id AS runId, bot_id AS botId, session_id AS sessionId, ${DIMENSION_SQL.cause} AS causeKey, trigger, first, charge, operations FROM billing_spend_runs WHERE ${runs.clause} ORDER BY charge DESC LIMIT 10`,
        query.since,
        query.until,
        ...runs.bindings,
      )
      .toArray();
  }
  const labels = Object.fromEntries(
    sql
      .exec<{ key: string; label: string }>(
        "SELECT key, label FROM billing_spend_labels",
      )
      .toArray()
      .map((row) => [row.key, row.label]),
  );
  const span = query.until - query.since;
  const previous = where(
    { ...query, since: query.since - span, until: query.since },
    "hour",
  );
  const previousTotal =
    sql
      .exec<{ micros: number }>(
        `SELECT COALESCE(SUM(charge), 0) AS micros FROM billing_spend_hourly WHERE ${previous.clause}`,
        Math.floor((query.since - span) / HOUR_MS),
        Math.floor(query.since / HOUR_MS),
        ...previous.bindings,
      )
      .toArray()[0]?.micros ?? 0;
  const topCause =
    sql
      .exec<{ key: string; charge: number; turns: number }>(
        `SELECT (${DIMENSION_SQL.cause}) AS key, SUM(charge) AS charge, SUM(turns) AS turns FROM billing_spend_hourly WHERE ${hourly.clause} GROUP BY key ORDER BY charge DESC LIMIT 1`,
        Math.floor(query.since / HOUR_MS),
        Math.ceil(query.until / HOUR_MS),
        ...hourly.bindings,
      )
      .toArray()[0] ?? null;
  return { hours, topTurns, labels, previousTotal, topCause };
}

/**
 * What the account has spent a day, on average, over the last week: the
 * pace its remaining credit is measured against. Account-wide, whatever the
 * view, because the credit is.
 */
export function dailySpendV1(sql: BillingSql, now: number): number {
  return Math.round(spentSinceV1(sql, now - 7 * DAY_MS) / 7);
}

export interface SpendingNamesV1 {
  /** The account's Bots by id. A Bot since deleted has none. */
  bots: Record<string, string>;
  /** The account's User id, which a Bot's own conversation id starts with. */
  userId: string;
}

export interface SpendingGroupV1 {
  key: string;
  label: string;
  /** Which Bot, where the label alone does not say. */
  detail?: string;
  chargeMicros: number;
  operations: number;
  /** Absent when the grouping is finer than a Turn. */
  turns?: number;
}

/** How long the account's credit lasts at its recent pace. */
export interface SpendingCreditV1 {
  /** What the account can spend now. */
  availableMicros: number;
  /** Its average daily spend over the last seven days. */
  dailyMicros: number;
  /** When the credit runs out at that pace; null when nothing is being spent. */
  runsOutAt: number | null;
  /** When the monthly allowance next renews; null without a subscription. */
  renewsAt: number | null;
}

/** How many groups the daily bars split out; the rest is one "Other". */
export const SPEND_STACKED_GROUPS_V1 = 5;

export interface SpendingReportV1 {
  since: number;
  until: number;
  timezone: string;
  groupBy: SpendDimensionV1;
  filters: { dimension: SpendDimensionV1; value: string; label: string }[];
  totalMicros: number;
  /** The same view over the window just before this one. */
  previousTotalMicros: number;
  operations: number;
  turns?: number;
  /**
   * Each of the person's days, split by the first groups in `groups` order
   * (at most `SPEND_STACKED_GROUPS_V1`), then everything else as one last
   * entry when there is more.
   */
  days: { day: string; chargeMicros: number; stack: number[] }[];
  /** The cause that spent the most in this view. */
  topCause: SpendingGroupV1 | null;
  credit: SpendingCreditV1 | null;
  groups: SpendingGroupV1[];
  topTurns:
    | {
        runId: string;
        botId: string;
        bot: string;
        cause: string;
        at: number;
        chargeMicros: number;
        operations: number;
      }[]
    | null;
}

const TRIGGER_LABELS: Record<string, string> = {
  person: "You",
  cron: "Schedule",
  webhook: "Webhook",
  manual: "Run by hand",
  connection: "Connected app",
  plugin: "Plugin",
  email: "Email",
};
const CATEGORY_LABELS: Record<string, string> = {
  model: "Model replies",
  summary: "Conversation summaries",
  search: "Web search",
  computer: "Computer time",
};

/** How one key of one dimension reads on the page. */
export function spendLabelV1(
  dimension: SpendDimensionV1,
  key: string,
  names: SpendingNamesV1,
  labels: Record<string, string>,
): { label: string; detail?: string } {
  const bot = (id: string) => names.bots[id] ?? "A deleted Bot";
  switch (dimension) {
    case "bot":
      return { label: key ? bot(key) : "Your account" };
    case "cause": {
      const [kind = "", botId = "", id = ""] = key.split("|");
      const named = labels[key];
      switch (kind) {
        case "chat":
          return { label: `Chat with ${bot(botId)}` };
        case "routine":
          return { label: named ?? "A Routine", detail: bot(botId) };
        case "group":
          return { label: named ?? "A Group Chat" };
        case "voice":
          return { label: "Voice" };
        case "email":
          return { label: `Email to ${bot(botId)}` };
        case "desktop":
          return { label: `You, on ${bot(botId)}'s Computer` };
        case "plugin":
          return { label: named ?? id, detail: "Plugin" };
        default:
          return { label: "Not attributed" };
      }
    }
    case "trigger":
      return { label: TRIGGER_LABELS[key] ?? "Not attributed" };
    case "conversation": {
      const split = key.indexOf("|");
      const botId = key.slice(0, split);
      const sessionId = key.slice(split + 1);
      if (sessionId === `${names.userId}:${botId}`)
        return { label: `Chat with ${bot(botId)}` };
      const routineId = routineIdOfSessionV1(sessionId);
      if (routineId !== undefined)
        return {
          label: labels[`routine|${botId}|${routineId}`] ?? "A Routine",
          detail: bot(botId),
        };
      const groupId = groupIdOfSessionV1(sessionId);
      if (groupId !== undefined)
        return { label: labels[`group||${groupId}`] ?? "A Group Chat" };
      if (sessionId.startsWith("task:"))
        return { label: "Subagent tasks", detail: bot(botId) };
      return {
        label: sessionId ? "Other work" : "Outside a conversation",
        detail: bot(botId),
      };
    }
    case "category":
      return { label: CATEGORY_LABELS[key] ?? key };
    case "model":
      return { label: key || "No model" };
    case "plugin":
      return { label: key || "The Bot itself" };
  }
}

function dayFormatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
}

/** The rollup rows as the page shows them, summed into the person's days. */
export function spendingReportV1(
  query: SpendingQueryV1,
  rows: SpendingRowsV1,
  names: SpendingNamesV1,
  timezone: string,
  credit: SpendingCreditV1 | null = null,
): SpendingReportV1 {
  const format = dayFormatter(timezone);
  const dayKeys = new Set<string>();
  for (let at = query.since; at < query.until; at += DAY_MS / 4)
    dayKeys.add(format.format(at));
  dayKeys.add(format.format(query.until - 1));
  const groups = new Map<string, SpendingGroupV1>();
  let total = 0;
  let operations = 0;
  let turns = 0;
  for (const row of rows.hours) {
    const group =
      groups.get(row.key) ??
      ({
        key: row.key,
        ...spendLabelV1(query.groupBy, row.key, names, rows.labels),
        chargeMicros: 0,
        operations: 0,
        turns: 0,
      } as SpendingGroupV1);
    group.chargeMicros += row.charge;
    group.operations += row.operations;
    group.turns = (group.turns ?? 0) + row.turns;
    groups.set(row.key, group);
    total += row.charge;
    operations += row.operations;
    turns += row.turns;
  }
  const countsTurns =
    TURN_DIMENSIONS.has(query.groupBy) && rows.topTurns !== null;
  const ranked = [...groups.values()].sort(
    (a, b) => b.chargeMicros - a.chargeMicros,
  );
  const stacked = ranked.slice(0, SPEND_STACKED_GROUPS_V1).map((g) => g.key);
  const width = stacked.length + (ranked.length > stacked.length ? 1 : 0);
  const days = new Map<string, number[]>(
    [...dayKeys].map((day) => [day, new Array<number>(width).fill(0)]),
  );
  for (const row of rows.hours) {
    const day = format.format(row.hour * HOUR_MS);
    const stack = days.get(day) ?? new Array<number>(width).fill(0);
    const slot = stacked.indexOf(row.key);
    stack[slot === -1 ? width - 1 : slot]! += row.charge;
    days.set(day, stack);
  }
  const topCause = rows.topCause
    ? {
        key: rows.topCause.key,
        ...spendLabelV1("cause", rows.topCause.key, names, rows.labels),
        chargeMicros: rows.topCause.charge,
        operations: 0,
        turns: rows.topCause.turns,
      }
    : null;
  return {
    since: query.since,
    until: query.until,
    timezone,
    groupBy: query.groupBy,
    filters: SPEND_DIMENSIONS_V1.flatMap((dimension) => {
      const value = query.filters[dimension];
      return value === undefined
        ? []
        : [
            {
              dimension,
              value,
              label: spendLabelV1(dimension, value, names, rows.labels).label,
            },
          ];
    }),
    totalMicros: total,
    previousTotalMicros: rows.previousTotal,
    operations,
    ...(rows.topTurns !== null ? { turns } : {}),
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, stack]) => ({
        day,
        chargeMicros: stack.reduce((sum, micros) => sum + micros, 0),
        stack,
      })),
    topCause,
    credit,
    groups: ranked.map((group) => {
      if (countsTurns) return group;
      const { turns: _turns, ...rest } = group;
      return rest;
    }),
    topTurns:
      rows.topTurns?.map((run) => ({
        runId: run.runId,
        botId: run.botId,
        bot: names.bots[run.botId] ?? "A deleted Bot",
        cause: spendLabelV1("cause", run.causeKey, names, rows.labels).label,
        at: run.first,
        chargeMicros: run.charge,
        operations: run.operations,
      })) ?? null,
  };
}

export type SpendPeriodV1 = "7d" | "30d" | "90d" | "billing";
export const SPEND_PERIODS_V1: readonly SpendPeriodV1[] = [
  "7d",
  "30d",
  "90d",
  "billing",
];

/** How long the account's credit lasts at the pace it has been spent. */
export function spendingCreditV1(
  availableMicros: number,
  dailyMicros: number,
  renewsAt: number | null,
  now: number,
): SpendingCreditV1 {
  return {
    availableMicros,
    dailyMicros,
    runsOutAt:
      dailyMicros > 0
        ? now + Math.floor((availableMicros / dailyMicros) * DAY_MS)
        : null,
    renewsAt,
  };
}

/** The window a period names, ending now. */
export function spendWindowV1(
  period: SpendPeriodV1,
  now: number,
  billingPeriodStart: number | undefined,
): { since: number; until: number } {
  const until = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS;
  // A lapsed subscription's last period can be long past; it reads as the
  // last 30 days rather than as everything since.
  if (
    period === "billing" &&
    billingPeriodStart !== undefined &&
    billingPeriodStart > until - 62 * DAY_MS
  )
    return { since: billingPeriodStart, until };
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  return { since: until - days * DAY_MS, until };
}
