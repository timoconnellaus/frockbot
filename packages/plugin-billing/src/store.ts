import {
  USAGE_DETAIL_MAX_ROWS_V1,
  USAGE_DETAIL_RETENTION_DAYS_V1,
  USAGE_MONTH_RETENTION_V1,
  type UsageBreakdownV1,
  type UsageEntryV1,
  type UsageReportV1,
} from "./shared.js";

export type UsageSqlValueV1 = ArrayBuffer | string | number | null;

export interface UsageSqlCursorV1<Row extends Record<string, UsageSqlValueV1>> {
  toArray(): Row[];
}

export interface UsageSqlV1 {
  exec<Row extends Record<string, UsageSqlValueV1>>(
    query: string,
    // SqlStorage uses `any[]`; retaining it here lets the native object satisfy
    // this deliberately tiny seam.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...bindings: any[]
  ): UsageSqlCursorV1<Row>;
}

const ENTRY_TABLE = "usage_entries";
const ROLLUP_TABLE = "usage_rollups";
const TOTAL_TABLE = "usage_lifetime";

interface AggregateRow extends Record<string, UsageSqlValueV1> {
  dimension_id: string;
  cost_micros: number;
  input_tokens: number;
  output_tokens: number;
  voice_seconds: number;
  estimated_calls: number;
  unknown_price_calls: number;
}

export interface UsageStoreOptionsV1 {
  sql: UsageSqlV1;
  now?: () => number;
  detailRetentionDays?: number;
  detailMaxRows?: number;
  monthRetention?: number;
}

function utcDayV1(at: string): string {
  return at.slice(0, 10);
}

function utcMonthV1(at: string): string {
  return at.slice(0, 7);
}

function breakdownV1(row: AggregateRow): UsageBreakdownV1 {
  return {
    id: String(row.dimension_id),
    costMicros: Number(row.cost_micros),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    voiceSeconds: Number(row.voice_seconds),
    estimatedCalls: Number(row.estimated_calls),
    unknownPriceCalls: Number(row.unknown_price_calls),
  };
}

export class UsageStoreV1 {
  private readonly sql: UsageSqlV1;
  private readonly now: () => number;
  private readonly detailRetentionDays: number;
  private readonly detailMaxRows: number;
  private readonly monthRetention: number;
  private opened = false;

  constructor(options: UsageStoreOptionsV1) {
    this.sql = options.sql;
    this.now = options.now ?? (() => Date.now());
    this.detailRetentionDays =
      options.detailRetentionDays ?? USAGE_DETAIL_RETENTION_DAYS_V1;
    this.detailMaxRows = options.detailMaxRows ?? USAGE_DETAIL_MAX_ROWS_V1;
    this.monthRetention = options.monthRetention ?? USAGE_MONTH_RETENTION_V1;
  }

  open(): void {
    if (this.opened) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ENTRY_TABLE} (` +
        "entry_id TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT, run_id TEXT, " +
        "turn_id TEXT, turn INTEGER, request_id TEXT, at TEXT NOT NULL, provider TEXT NOT NULL, " +
        "model TEXT NOT NULL, binding_id TEXT, input_tokens INTEGER NOT NULL, " +
        "output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, " +
        "reasoning_tokens INTEGER NOT NULL, voice_seconds INTEGER NOT NULL, " +
        "latency_ms INTEGER NOT NULL, estimated INTEGER NOT NULL, unknown_price INTEGER NOT NULL, " +
        "price_table_version TEXT NOT NULL, cost_micros INTEGER NOT NULL)",
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${ENTRY_TABLE}_at ON ${ENTRY_TABLE} (at)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLE} (` +
        "period_type TEXT NOT NULL, period TEXT NOT NULL, dimension TEXT NOT NULL, " +
        "dimension_id TEXT NOT NULL, cost_micros INTEGER NOT NULL, input_tokens INTEGER NOT NULL, " +
        "output_tokens INTEGER NOT NULL, voice_seconds INTEGER NOT NULL, estimated_calls INTEGER NOT NULL, " +
        "unknown_price_calls INTEGER NOT NULL, " +
        "PRIMARY KEY (period_type, period, dimension, dimension_id))",
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TOTAL_TABLE} (` +
        "id INTEGER PRIMARY KEY CHECK (id = 1), cost_micros INTEGER NOT NULL)",
    );
    this.opened = true;
  }

  record(entries: readonly UsageEntryV1[]): number {
    this.open();
    let inserted = 0;
    for (const entry of entries) {
      const known = this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${ENTRY_TABLE} WHERE entry_id = ?`,
          entry.entryId,
        )
        .toArray()[0]?.n;
      if (Number(known ?? 0) > 0) continue;
      this.sql.exec(
        `INSERT INTO ${ENTRY_TABLE} (` +
          "entry_id, kind, bot_id, run_id, turn_id, turn, request_id, at, provider, model, binding_id, " +
          "input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, voice_seconds, latency_ms, " +
          "estimated, unknown_price, price_table_version, cost_micros) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        entry.entryId,
        entry.kind,
        entry.botId ?? null,
        entry.runId ?? null,
        entry.turnId ?? null,
        entry.turn ?? null,
        entry.requestId ?? null,
        entry.at,
        entry.provider,
        entry.model,
        entry.bindingId ?? null,
        entry.inputTokens,
        entry.outputTokens,
        entry.cachedInputTokens,
        entry.reasoningTokens,
        entry.voiceSeconds,
        entry.latencyMs,
        entry.estimated ? 1 : 0,
        entry.unknownPrice ? 1 : 0,
        entry.priceTableVersion,
        entry.costMicros,
      );
      for (const [dimension, dimensionId] of [
        ["all", "all"],
        ...(entry.botId ? [["bot", entry.botId]] : []),
        ["model", `${entry.provider}/${entry.model}`],
      ] as const) {
        this.addRollup(
          "day",
          utcDayV1(entry.at),
          dimension,
          dimensionId,
          entry,
        );
        this.addRollup(
          "month",
          utcMonthV1(entry.at),
          dimension,
          dimensionId,
          entry,
        );
      }
      this.sql.exec(
        `INSERT INTO ${TOTAL_TABLE} (id, cost_micros) VALUES (1, ?) ` +
          "ON CONFLICT(id) DO UPDATE SET cost_micros = cost_micros + excluded.cost_micros",
        entry.costMicros,
      );
      inserted += 1;
    }
    this.evict();
    return inserted;
  }

  private addRollup(
    periodType: "day" | "month",
    period: string,
    dimension: string,
    dimensionId: string,
    entry: UsageEntryV1,
  ): void {
    this.sql.exec(
      `INSERT INTO ${ROLLUP_TABLE} (` +
        "period_type, period, dimension, dimension_id, cost_micros, input_tokens, output_tokens, " +
        "voice_seconds, estimated_calls, unknown_price_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(period_type, period, dimension, dimension_id) DO UPDATE SET " +
        "cost_micros = cost_micros + excluded.cost_micros, " +
        "input_tokens = input_tokens + excluded.input_tokens, " +
        "output_tokens = output_tokens + excluded.output_tokens, " +
        "voice_seconds = voice_seconds + excluded.voice_seconds, " +
        "estimated_calls = estimated_calls + excluded.estimated_calls, " +
        "unknown_price_calls = unknown_price_calls + excluded.unknown_price_calls",
      periodType,
      period,
      dimension,
      dimensionId,
      entry.costMicros,
      entry.inputTokens,
      entry.outputTokens,
      entry.voiceSeconds,
      entry.estimated ? 1 : 0,
      entry.unknownPrice ? 1 : 0,
    );
  }

  private evict(): void {
    const now = this.now();
    const detailHorizon = new Date(
      now - this.detailRetentionDays * 24 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, 10);
    this.sql.exec(`DELETE FROM ${ENTRY_TABLE} WHERE at < ?`, detailHorizon);
    this.sql.exec(
      `DELETE FROM ${ROLLUP_TABLE} WHERE period_type = 'day' AND period < ?`,
      detailHorizon,
    );
    const excess =
      Number(
        this.sql
          .exec<{ n: number }>(`SELECT count(*) AS n FROM ${ENTRY_TABLE}`)
          .toArray()[0]?.n ?? 0,
      ) - this.detailMaxRows;
    if (excess > 0) {
      this.sql.exec(
        `DELETE FROM ${ENTRY_TABLE} WHERE entry_id IN (` +
          `SELECT entry_id FROM ${ENTRY_TABLE} ORDER BY at ASC, entry_id ASC LIMIT ?)`,
        excess,
      );
    }
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - this.monthRetention);
    this.sql.exec(
      `DELETE FROM ${ROLLUP_TABLE} WHERE period_type = 'month' AND period < ?`,
      cutoff.toISOString().slice(0, 7),
    );
  }

  report(at = new Date(this.now())): UsageReportV1 {
    this.open();
    this.evict();
    const month = at.toISOString().slice(0, 7);
    const all = this.sql
      .exec<AggregateRow>(
        `SELECT dimension_id, cost_micros, input_tokens, output_tokens, voice_seconds, ` +
          `estimated_calls, unknown_price_calls FROM ${ROLLUP_TABLE} ` +
          "WHERE period_type = 'month' AND period = ? AND dimension = 'all'",
        month,
      )
      .toArray()[0];
    const empty: AggregateRow = {
      dimension_id: "all",
      cost_micros: 0,
      input_tokens: 0,
      output_tokens: 0,
      voice_seconds: 0,
      estimated_calls: 0,
      unknown_price_calls: 0,
    };
    const total = breakdownV1(all ?? empty);
    const rows = (dimension: "bot" | "model") =>
      this.sql
        .exec<AggregateRow>(
          `SELECT dimension_id, cost_micros, input_tokens, output_tokens, voice_seconds, ` +
            `estimated_calls, unknown_price_calls FROM ${ROLLUP_TABLE} ` +
            "WHERE period_type = 'month' AND period = ? AND dimension = ? " +
            "ORDER BY cost_micros DESC, dimension_id ASC",
          month,
          dimension,
        )
        .toArray()
        .map(breakdownV1);
    const firstDay = new Date(at);
    firstDay.setUTCHours(0, 0, 0, 0);
    firstDay.setUTCDate(firstDay.getUTCDate() - 29);
    const byDay = new Map(
      this.sql
        .exec<{ period: string; cost_micros: number }>(
          `SELECT period, cost_micros FROM ${ROLLUP_TABLE} ` +
            "WHERE period_type = 'day' AND dimension = 'all' AND period >= ? ORDER BY period ASC",
          firstDay.toISOString().slice(0, 10),
        )
        .toArray()
        .map((row) => [String(row.period), Number(row.cost_micros)]),
    );
    const days = Array.from({ length: 30 }, (_, offset) => {
      const day = new Date(firstDay);
      day.setUTCDate(day.getUTCDate() + offset);
      const key = day.toISOString().slice(0, 10);
      return { day: key, costMicros: byDay.get(key) ?? 0 };
    });
    const lifetime = Number(
      this.sql
        .exec<{ cost_micros: number }>(
          `SELECT cost_micros FROM ${TOTAL_TABLE} WHERE id = 1`,
        )
        .toArray()[0]?.cost_micros ?? 0,
    );
    return {
      schemaVersion: 1,
      month,
      currentMonthCostMicros: total.costMicros,
      lifetimeCostMicros: lifetime,
      currentMonthInputTokens: total.inputTokens,
      currentMonthOutputTokens: total.outputTokens,
      currentMonthVoiceSeconds: total.voiceSeconds,
      estimatedCalls: total.estimatedCalls,
      unknownPriceCalls: total.unknownPriceCalls,
      bots: rows("bot"),
      models: rows("model"),
      days,
    };
  }
}
