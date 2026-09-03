// The audit table: one deep module over one narrow SQL seam.
//
// WHERE IT LIVES. One table per User, in the User Durable Object —
// `AGENTS.md` § Authorities, "The User's Durable Object is the authority for
// everything User-scoped". It sits beside the transcript index and shares
// nothing with it: audit is filtered and paged by kind, target and time rather
// than searched, its retention policy is different, and it must not be
// reachable from a stray free-text query. A separate plain table, no FTS.
//
// WHAT IT IS NOT. It is not authority. Every row is a projection of the
// `tool/call` and `tool/result` events a Bot Durable Object already holds, and
// `rebuild()` reconstructs the whole table from them. A lost, corrupt, or
// evicted table costs a rebuild and nothing else.
//
// RETENTION. Two bounds, both durable and both visible: at most
// {@link AUDIT_MAX_ROWS_V1} rows per User, and nothing older than
// {@link AUDIT_MAX_AGE_MS_V1}. Enforcing a bound by discarding rather than
// refusing means the loss has to be observable, so it sets `audit-truncated`,
// which the UI shows and a rebuild clears.
import {
  AUDIT_MAX_AGE_MS_V1,
  AUDIT_MAX_ROWS_V1,
  type AuditEntryV1,
  type AuditIndexStateV1,
} from "./shared.js";

/** Exactly the column types SQLite storage returns. */
export type AuditSqlValueV1 = ArrayBuffer | string | number | null;

export interface AuditSqlCursorV1<Row extends Record<string, AuditSqlValueV1>> {
  toArray(): Row[];
}

export interface AuditSqlV1 {
  exec<Row extends Record<string, AuditSqlValueV1>>(
    query: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `SqlStorage.exec`
    // declares `any[]`; a narrower parameter type here would stop
    // `ctx.storage.sql` satisfying this interface at all.
    ...bindings: any[]
  ): AuditSqlCursorV1<Row>;
}

const TABLE = "audit_entries";
/**
 * Where a rebuild accumulates rows before it replaces the live table.
 *
 * A rebuild used to `DELETE FROM` the live table before it fetched page one,
 * so any source failure left a truncated table still reporting `ready`. It
 * fills this instead and swaps at the end, which makes a failed rebuild cost
 * nothing.
 */
const SHADOW_TABLE = "audit_entries_rebuild";
const META_TABLE = "audit_meta";
const TRUNCATED_KEY = "audit-truncated";
const REBUILDING_KEY = "audit-rebuilding";

/** The page size a rebuild pulls from one Bot at a time. */
export const AUDIT_REBUILD_PAGE_V1 = 32;

/**
 * How long a rebuild holds the lock before another may take it.
 *
 * `REBUILDING_KEY` was written and never read as a lock, so two concurrent
 * rebuilds wiped each other. It now records when the rebuild started, and a
 * marker older than this is a rebuild whose isolate died — not a reason for
 * the table to be unrebuildable for ever.
 */
export const AUDIT_REBUILD_LOCK_MS = 10 * 60_000;

/** The columns both the live table and the rebuild's shadow carry. */
const AUDIT_COLUMNS =
  "bot_id TEXT NOT NULL, run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, " +
  "turn INTEGER NOT NULL, step INTEGER NOT NULL, ordinal INTEGER NOT NULL, " +
  "effect_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, " +
  "target TEXT NOT NULL, tool_name TEXT NOT NULL, argument_digest TEXT NOT NULL, " +
  "preview TEXT NOT NULL, outcome TEXT NOT NULL, exit_code INTEGER, " +
  "duration_ms INTEGER, bytes_out INTEGER, " +
  "PRIMARY KEY (bot_id, run_id, occurrence_id)";

export interface AuditStoreOptionsV1 {
  sql: AuditSqlV1;
  /** Overridable so a test can drive eviction without twenty thousand rows. */
  maxRows?: number;
  /** Overridable so a test can drive age eviction without waiting 180 days. */
  maxAgeMs?: number;
  now?: () => number;
}

/** One Bot's entries, as the table pulls them during a rebuild. */
export interface AuditEntrySourceV1 {
  botId: string;
  page(
    cursor?: string,
  ): Promise<{ entries: AuditEntryV1[]; nextCursor?: string }>;
}

export interface AuditRebuildOutcomeV1 {
  entries: number;
  bots: number;
  indexState: AuditIndexStateV1;
}

interface AuditRow extends Record<string, AuditSqlValueV1> {
  bot_id: string;
  run_id: string;
  occurrence_id: string;
  turn: number;
  step: number;
  ordinal: number;
  effect_id: string;
  at: string;
  kind: string;
  target: string;
  tool_name: string;
  argument_digest: string;
  preview: string;
  outcome: string;
  exit_code: number | null;
  duration_ms: number | null;
  bytes_out: number | null;
}

function fromRow(row: AuditRow): AuditEntryV1 {
  return {
    schemaVersion: 1,
    botId: String(row.bot_id),
    runId: String(row.run_id),
    occurrenceId: String(row.occurrence_id),
    turn: Number(row.turn),
    step: Number(row.step),
    ordinal: Number(row.ordinal),
    effectId: String(row.effect_id),
    at: String(row.at),
    kind: String(row.kind) as AuditEntryV1["kind"],
    target: String(row.target),
    toolName: String(row.tool_name),
    argumentDigest: String(row.argument_digest),
    preview: String(row.preview),
    outcome: String(row.outcome) as AuditEntryV1["outcome"],
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.duration_ms === null
      ? {}
      : { durationMs: Number(row.duration_ms) }),
    ...(row.bytes_out === null ? {} : { bytesOut: Number(row.bytes_out) }),
  };
}

export class AuditStoreV1 {
  private readonly sql: AuditSqlV1;
  private readonly maxRows: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private opened = false;

  constructor(options: AuditStoreOptionsV1) {
    this.sql = options.sql;
    this.maxRows = options.maxRows ?? AUDIT_MAX_ROWS_V1;
    this.maxAgeMs = options.maxAgeMs ?? AUDIT_MAX_AGE_MS_V1;
    this.now = options.now ?? (() => Date.now());
  }

  /** Creates the table if it is absent. Safe to call on every request. */
  open(): void {
    if (this.opened) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (${AUDIT_COLUMNS})`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_at ON ${TABLE} (at)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_bot_at ON ${TABLE} (bot_id, at)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_kind_at ON ${TABLE} (kind, at)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.opened = true;
  }

  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ value: string }>(
        `SELECT value FROM ${META_TABLE} WHERE key = ?`,
        key,
      )
      .toArray()[0]?.value;
  }

  private setMeta(key: string, value: string | undefined): void {
    if (value === undefined) {
      this.sql.exec(`DELETE FROM ${META_TABLE} WHERE key = ?`, key);
      return;
    }
    this.sql.exec(
      `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ` +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** `ready`, or the durable marker that says otherwise. */
  state(): AuditIndexStateV1 {
    this.open();
    if (this.meta(REBUILDING_KEY)) return "rebuilding";
    return this.meta(TRUNCATED_KEY) ? "truncated" : "ready";
  }

  count(): number {
    this.open();
    return Number(
      this.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM ${TABLE}`)
        .toArray()[0]?.n ?? 0,
    );
  }

  /**
   * Inserts entries, idempotently on `(botId, runId, occurrenceId)`.
   *
   * Returns how many were new. A Turn that settles twice — a redelivered
   * outbox, a rebuild over a live table — inserts nothing the second time,
   * which is what makes the outbox's at-least-once delivery safe.
   */
  insert(entries: readonly AuditEntryV1[]): number {
    this.open();
    const inserted = this.insertInto(TABLE, entries);
    this.evict();
    return inserted;
  }

  /** The insert half, named so a rebuild can aim it at its shadow table. */
  private insertInto(table: string, entries: readonly AuditEntryV1[]): number {
    let inserted = 0;
    for (const entry of entries) {
      const existing = this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${table} WHERE bot_id = ? AND run_id = ? AND occurrence_id = ?`,
          entry.botId,
          entry.runId,
          entry.occurrenceId,
        )
        .toArray();
      if (Number(existing[0]?.n ?? 0) > 0) continue;
      this.sql.exec(
        `INSERT INTO ${table} (bot_id, run_id, occurrence_id, turn, step, ordinal, ` +
          "effect_id, at, kind, target, tool_name, argument_digest, preview, outcome, " +
          "exit_code, duration_ms, bytes_out) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        entry.botId,
        entry.runId,
        entry.occurrenceId,
        entry.turn,
        entry.step,
        entry.ordinal,
        entry.effectId,
        entry.at,
        entry.kind,
        entry.target,
        entry.toolName,
        entry.argumentDigest,
        entry.preview,
        entry.outcome,
        entry.exitCode ?? null,
        entry.durationMs ?? null,
        entry.bytesOut ?? null,
      );
      inserted += 1;
    }
    return inserted;
  }

  /**
   * Enforces both durable bounds by discarding the oldest rows.
   *
   * Age first, then count: an entry past the age bound leaves whatever the row
   * count is, so retention is a promise about time and not only about volume.
   */
  private evict(): void {
    let evicted = false;
    const horizon = new Date(this.now() - this.maxAgeMs).toISOString();
    const aged = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM ${TABLE} WHERE at < ?`,
        horizon,
      )
      .toArray();
    if (Number(aged[0]?.n ?? 0) > 0) {
      this.sql.exec(`DELETE FROM ${TABLE} WHERE at < ?`, horizon);
      evicted = true;
    }
    let excess = this.count() - this.maxRows;
    while (excess > 0) {
      const oldest = this.sql
        .exec<{ bot_id: string; run_id: string; occurrence_id: string }>(
          `SELECT bot_id, run_id, occurrence_id FROM ${TABLE} ` +
            "ORDER BY at ASC, bot_id ASC, run_id ASC, occurrence_id ASC LIMIT ?",
          Math.min(excess, 256),
        )
        .toArray();
      if (oldest.length === 0) break;
      for (const key of oldest) {
        this.sql.exec(
          `DELETE FROM ${TABLE} WHERE bot_id = ? AND run_id = ? AND occurrence_id = ?`,
          key.bot_id,
          key.run_id,
          key.occurrence_id,
        );
      }
      excess -= oldest.length;
      evicted = true;
    }
    if (evicted) this.setMeta(TRUNCATED_KEY, "1");
  }

  /** Every entry of one Bot leaves the table; the archive saga calls this. */
  purge(botId: string): number {
    this.open();
    const removed = Number(
      this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${TABLE} WHERE bot_id = ?`,
          botId,
        )
        .toArray()[0]?.n ?? 0,
    );
    this.sql.exec(`DELETE FROM ${TABLE} WHERE bot_id = ?`, botId);
    return removed;
  }

  /**
   * Every entry, newest first. The route's filters and paging sit on top of
   * this in `query.ts`; this is the whole-table read a rebuild compares
   * against and a test asserts on.
   */
  all(): AuditEntryV1[] {
    this.open();
    return this.sql
      .exec<AuditRow>(
        `SELECT * FROM ${TABLE} ORDER BY at DESC, bot_id ASC, run_id ASC, occurrence_id ASC`,
      )
      .toArray()
      .map(fromRow);
  }

  /**
   * One filtered, paged answer.
   *
   * The cursor is an offset rather than a key range, matching the transcript
   * index's, because the table is bounded at twenty thousand rows: the deepest
   * possible page is cheap, and an opaque offset cannot be used to address a
   * row the filters would have excluded.
   */
  query(request: {
    botId?: string;
    kind?: string;
    target?: string;
    before?: string;
    limit?: number;
  }): { entries: AuditEntryV1[]; nextCursor?: string; total: number } {
    this.open();
    // Retention is a promise about time, so it cannot be enforced only when
    // something is written: a Bot nobody has spoken to for a year kept every
    // row past the 180-day bound simply because no insert came to evict them.
    this.evict();
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);
    const offset = decodeAuditOffsetV1(request.before);
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (request.botId) {
      clauses.push("bot_id = ?");
      bindings.push(request.botId);
    }
    if (request.kind) {
      clauses.push("kind = ?");
      bindings.push(request.kind);
    }
    if (request.target) {
      clauses.push("target = ?");
      bindings.push(request.target);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(
      this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${TABLE}${where}`,
          ...bindings,
        )
        .toArray()[0]?.n ?? 0,
    );
    const rows = this.sql
      .exec<AuditRow>(
        `SELECT * FROM ${TABLE}${where} ` +
          "ORDER BY at DESC, bot_id ASC, run_id ASC, occurrence_id ASC LIMIT ? OFFSET ?",
        ...bindings,
        limit + 1,
        offset,
      )
      .toArray();
    const page = rows.slice(0, limit).map(fromRow);
    return {
      entries: page,
      ...(rows.length > limit
        ? { nextCursor: `p${offset + page.length}` }
        : {}),
      total,
    };
  }

  /**
   * Discards the table and re-projects it from the Bots' own stored runs.
   *
   * This is the correctness story for the whole Package: the table is
   * disposable because this exists, and it is the same projection function
   * settlement uses, so a rebuild and a lifetime of incremental projections
   * produce the identical set. The `rebuilding` marker is durable, so a
   * rebuild interrupted by eviction is visible as an unfinished table rather
   * than silently reported as ready.
   */
  async rebuild(
    sources: readonly AuditEntrySourceV1[],
  ): Promise<AuditRebuildOutcomeV1> {
    this.open();
    const held = this.meta(REBUILDING_KEY);
    const startedAt = held === undefined ? undefined : Number(held);
    if (
      startedAt !== undefined &&
      Number.isFinite(startedAt) &&
      this.now() - startedAt < AUDIT_REBUILD_LOCK_MS
    ) {
      // The marker was written and never read as a lock, so two concurrent
      // rebuilds wiped each other. It is a lock now.
      throw new Error("an audit rebuild is already running");
    }
    this.setMeta(REBUILDING_KEY, String(this.now()));
    let entries = 0;
    try {
      // Append, then swap. Nothing touches the live table until every source
      // has answered, so a source that fails halfway costs a rebuild and not
      // the table — where before the rows were deleted before page one was
      // even fetched, and a failure left a truncated table reporting `ready`.
      this.sql.exec(`DROP TABLE IF EXISTS ${SHADOW_TABLE}`);
      this.sql.exec(`CREATE TABLE ${SHADOW_TABLE} (${AUDIT_COLUMNS})`);
      for (const source of sources) {
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await source.page(cursor);
          entries += this.insertInto(
            SHADOW_TABLE,
            page.entries.filter((entry) => entry.botId === source.botId),
          );
          cursor = page.nextCursor;
          pages += 1;
          // A Bot cannot page for ever: the run index is bounded, and a source
          // that never stops offering pages is a fault, not a large Bot.
        } while (cursor && pages < 10_000);
      }
      this.sql.exec(`DROP TABLE ${TABLE}`);
      this.sql.exec(`ALTER TABLE ${SHADOW_TABLE} RENAME TO ${TABLE}`);
      // The indexes went with the table the rename replaced.
      this.opened = false;
      this.open();
      this.setMeta(TRUNCATED_KEY, undefined);
      this.evict();
    } catch (error) {
      this.sql.exec(`DROP TABLE IF EXISTS ${SHADOW_TABLE}`);
      throw error;
    } finally {
      this.setMeta(REBUILDING_KEY, undefined);
    }
    return { entries, bots: sources.length, indexState: this.state() };
  }
}

const CURSOR_PATTERN = /^p([0-9]{1,9})$/;

/** The offset an opaque page cursor names. */
export function decodeAuditOffsetV1(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new Error("audit cursor is invalid");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset > 100_000) {
    throw new Error("audit cursor is invalid");
  }
  return offset;
}
