// The transcript index: one deep module over one narrow SQL seam.
//
// WHERE IT LIVES. One index per User, in the User Durable Object —
// `AGENTS.md` § Authorities, "The User's Durable Object is the authority for
// everything User-scoped". GrokBot keeps one `search-index.db` holding the
// transcripts of all fourteen agents (`docs/research/grokbot-computer.md:78`),
// and this is the same shape: one table, one query, no fan-out at read time.
//
// WHAT IT IS NOT. It is not authority. Every row is a projection of a settled
// `StoredRunV1` that the owning Bot Durable Object holds, and `rebuild()`
// reconstructs the whole table from those runs. A lost, corrupt, or evicted
// index costs a rebuild and nothing else, which is the only reason it is
// allowed to exist outside the Durable Object that owns the conversation.
//
// FTS5. `CREATE VIRTUAL TABLE … USING fts5` is accepted by the Durable Object
// SQL authorizer — proven by `apps/cloudflare/test/search.workerd.ts`, which
// creates the real table on `ctx.storage.sql` before anything else runs. The
// metadata columns are `UNINDEXED` so they cost no tokens, and a companion
// ordinary table carries the `(bot_id, run_id, seq)` primary key FTS5 cannot:
// it is what makes a re-projected turn idempotent rather than duplicated.
import {
  boundSearchBodyV1,
  SEARCH_DEFAULT_ROW_KINDS_V1,
  SEARCH_MAX_CURSOR_LENGTH_V1,
  SEARCH_MAX_QUERY_LENGTH_V1,
  SEARCH_MAX_RESULTS_V1,
  SEARCH_MAX_ROWS_V1,
  SEARCH_MAX_SNIPPET_LENGTH_V1,
  SEARCH_ROW_KINDS_V1,
  type SearchIndexResultsV1,
  type SearchIndexStateV1,
  type SearchQueryV1,
  type SearchRowKindV1,
  type SearchRowV1,
} from "./shared.js";

// The SQL surface this module consumes: exactly what `ctx.storage.sql` offers
// and nothing more, so the module's tests can supply a fake cursor and the
// Durable Object type never reaches this Package.

/** Exactly the column types SQLite storage returns. */
export type SearchSqlValueV1 = ArrayBuffer | string | number | null;

export interface SearchSqlCursorV1<
  Row extends Record<string, SearchSqlValueV1>,
> {
  toArray(): Row[];
}

export interface SearchSqlV1 {
  exec<Row extends Record<string, SearchSqlValueV1>>(
    query: string,
    // eslint-disable-next-line -- `SqlStorage.exec` declares `any[]`; a
    // narrower parameter type here would stop `ctx.storage.sql` satisfying
    // this interface at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...bindings: any[]
  ): SearchSqlCursorV1<Row>;
}

const ROWS_TABLE = "search_rows";
const KEYS_TABLE = "search_keys";
const META_TABLE = "search_meta";

const TRUNCATED_KEY = "index-truncated";
const REBUILDING_KEY = "index-rebuilding";

/** The page size a rebuild pulls from one Bot at a time. */
export const SEARCH_REBUILD_PAGE_V1 = 32;

export interface SearchIndexOptionsV1 {
  sql: SearchSqlV1;
  /** Overridable so a test can drive eviction without two million rows. */
  maxRows?: number;
}

/** One Bot's rows, as the index pulls them during a rebuild. */
export interface SearchRowSourceV1 {
  botId: string;
  /** Returns one page and the cursor for the next, or `undefined` when done. */
  page(cursor?: string): Promise<{ rows: SearchRowV1[]; nextCursor?: string }>;
}

export interface SearchRebuildOutcomeV1 {
  indexedRows: number;
  bots: number;
  indexState: SearchIndexStateV1;
}

const CURSOR_PATTERN = /^p([0-9]{1,9})$/;

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (cursor.length > SEARCH_MAX_CURSOR_LENGTH_V1) {
    throw new Error("search cursor is invalid");
  }
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new Error("search cursor is invalid");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset > 100_000) {
    throw new Error("search cursor is invalid");
  }
  return offset;
}

/**
 * Turns a person's words into an FTS5 MATCH expression.
 *
 * Every token is quoted, which is what makes this safe: FTS5's own operators
 * (`NEAR`, `OR`, `-`, `^`, `*`, column filters) are syntax outside quotes and
 * literal text inside them, so a query containing them searches for them
 * rather than executing them. The final token also matches by prefix, because
 * a search box is read while it is still being typed.
 */
export function searchMatchExpressionV1(query: string): string | undefined {
  const tokens = query
    .slice(0, SEARCH_MAX_QUERY_LENGTH_V1)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 16);
  if (tokens.length === 0) return undefined;
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

export class SearchIndexV1 {
  private readonly sql: SearchSqlV1;
  private readonly maxRows: number;
  private opened = false;

  constructor(options: SearchIndexOptionsV1) {
    this.sql = options.sql;
    this.maxRows = options.maxRows ?? SEARCH_MAX_ROWS_V1;
  }

  /** Creates the tables if they are absent. Safe to call on every request. */
  open(): void {
    if (this.opened) return;
    this.sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${ROWS_TABLE} USING fts5(` +
        "body, bot_id UNINDEXED, run_id UNINDEXED, seq UNINDEXED, " +
        "kind UNINDEXED, at UNINDEXED, tokenize='unicode61')",
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${KEYS_TABLE} (` +
        "bot_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, " +
        "at TEXT NOT NULL, PRIMARY KEY (bot_id, run_id, seq))",
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${KEYS_TABLE}_at ON ${KEYS_TABLE} (at)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.opened = true;
  }

  private meta(key: string): string | undefined {
    const rows = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM ${META_TABLE} WHERE key = ?`,
        key,
      )
      .toArray();
    return rows[0]?.value;
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

  /**
   * `ready`, or the durable marker that says otherwise.
   *
   * Truncation is durable and visible: a User whose oldest turns were evicted
   * to stay inside the row quota sees so in the UI rather than silently
   * getting fewer answers, which is the quota rule's "records a visible
   * failure" for a bound that is enforced by discarding rather than refusing.
   */
  state(): SearchIndexStateV1 {
    this.open();
    if (this.meta(REBUILDING_KEY)) return "rebuilding";
    return this.meta(TRUNCATED_KEY) ? "truncated" : "ready";
  }

  count(): number {
    this.open();
    const rows = this.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM ${KEYS_TABLE}`)
      .toArray();
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Projects rows into the index, idempotently on `(botId, runId, seq)`.
   *
   * Returns how many rows were new. A Turn that settles twice — a retried RPC,
   * a rebuild over a live index — inserts nothing the second time, which is
   * what lets the write path be a fire-and-forget projection rather than a
   * transaction the Turn has to wait on.
   */
  insert(rows: readonly SearchRowV1[]): number {
    this.open();
    let inserted = 0;
    for (const row of rows) {
      const existing = this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM ${KEYS_TABLE} WHERE bot_id = ? AND run_id = ? AND seq = ?`,
          row.botId,
          row.runId,
          row.seq,
        )
        .toArray();
      if (Number(existing[0]?.n ?? 0) > 0) continue;
      const body = boundSearchBodyV1(row.body);
      this.sql.exec(
        `INSERT INTO ${ROWS_TABLE} (body, bot_id, run_id, seq, kind, at) VALUES (?, ?, ?, ?, ?, ?)`,
        body,
        row.botId,
        row.runId,
        row.seq,
        row.kind,
        row.at,
      );
      this.sql.exec(
        `INSERT INTO ${KEYS_TABLE} (bot_id, run_id, seq, at) VALUES (?, ?, ?, ?)`,
        row.botId,
        row.runId,
        row.seq,
        row.at,
      );
      inserted += 1;
    }
    this.evict();
    return inserted;
  }

  /** Enforces the durable per-User row quota by discarding the oldest rows. */
  private evict(): void {
    let excess = this.count() - this.maxRows;
    if (excess <= 0) return;
    while (excess > 0) {
      const oldest = this.sql
        .exec<{ bot_id: string; run_id: string; seq: number }>(
          `SELECT bot_id, run_id, seq FROM ${KEYS_TABLE} ORDER BY at ASC, bot_id ASC, run_id ASC, seq ASC LIMIT ?`,
          Math.min(excess, 256),
        )
        .toArray();
      if (oldest.length === 0) break;
      for (const key of oldest) {
        this.deleteRow(key.bot_id, key.run_id, Number(key.seq));
      }
      excess -= oldest.length;
    }
    this.setMeta(TRUNCATED_KEY, "1");
  }

  private deleteRow(botId: string, runId: string, seq: number): void {
    this.sql.exec(
      `DELETE FROM ${ROWS_TABLE} WHERE bot_id = ? AND run_id = ? AND seq = ?`,
      botId,
      runId,
      seq,
    );
    this.sql.exec(
      `DELETE FROM ${KEYS_TABLE} WHERE bot_id = ? AND run_id = ? AND seq = ?`,
      botId,
      runId,
      seq,
    );
  }

  /** Every row of one Bot leaves the index; the lifecycle saga calls this. */
  purge(botId: string): number {
    this.open();
    const removed = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM ${KEYS_TABLE} WHERE bot_id = ?`,
        botId,
      )
      .toArray();
    this.sql.exec(`DELETE FROM ${ROWS_TABLE} WHERE bot_id = ?`, botId);
    this.sql.exec(`DELETE FROM ${KEYS_TABLE} WHERE bot_id = ?`, botId);
    return Number(removed[0]?.n ?? 0);
  }

  /**
   * One page of hits, most relevant first.
   *
   * `archivedBotIds` is re-checked here rather than trusted from write time: a
   * Bot archived after its turns were indexed must disappear from default
   * results without a rebuild, so lifecycle is a query-time filter over live
   * directory state, never a column.
   */
  query(
    request: SearchQueryV1,
    directory: { archivedBotIds: readonly string[] },
  ): SearchIndexResultsV1 {
    this.open();
    const indexState = this.state();
    const match = searchMatchExpressionV1(request.query);
    const empty: SearchIndexResultsV1 = {
      schemaVersion: 1,
      query: request.query,
      hits: [],
      truncated: false,
      indexState,
    };
    if (!match) return empty;
    const kinds = (request.kinds ?? SEARCH_DEFAULT_ROW_KINDS_V1).filter(
      (kind): kind is SearchRowKindV1 => SEARCH_ROW_KINDS_V1.includes(kind),
    );
    if (kinds.length === 0) return empty;
    const excluded = request.includeArchived
      ? []
      : [...new Set(directory.archivedBotIds)];
    const offset = decodeOffset(request.before);

    const bindings: unknown[] = [match, ...kinds];
    let where = `${ROWS_TABLE} MATCH ? AND kind IN (${kinds.map(() => "?").join(", ")})`;
    if (request.botId) {
      where += " AND bot_id = ?";
      bindings.push(request.botId);
    }
    if (excluded.length > 0) {
      where += ` AND bot_id NOT IN (${excluded.map(() => "?").join(", ")})`;
      bindings.push(...excluded);
    }
    const limit = SEARCH_MAX_RESULTS_V1;
    const rows = this.sql
      .exec<{
        bot_id: string;
        run_id: string;
        seq: number;
        kind: string;
        at: string;
        snippet: string;
      }>(
        `SELECT bot_id, run_id, seq, kind, at, ` +
          `snippet(${ROWS_TABLE}, 0, '', '', '…', 24) AS snippet ` +
          `FROM ${ROWS_TABLE} WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`,
        ...bindings,
        limit + 1,
        offset,
      )
      .toArray();
    const truncated = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      schemaVersion: 1,
      query: request.query,
      hits: page.map((row) => ({
        botId: String(row.bot_id),
        runId: String(row.run_id),
        kind: String(row.kind) as SearchRowKindV1,
        at: String(row.at),
        snippet: String(row.snippet ?? "").slice(
          0,
          SEARCH_MAX_SNIPPET_LENGTH_V1,
        ),
      })),
      truncated,
      ...(truncated ? { nextCursor: `p${offset + page.length}` } : {}),
      indexState,
    };
  }

  /**
   * Discards the table and re-projects it from the Bots' own stored runs.
   *
   * This is the correctness story for the whole Package. The index is
   * disposable because this exists: it is the same code path a Bot's backfill
   * uses, so a rebuild and a lifetime of incremental projections produce the
   * identical result set. The `rebuilding` marker is durable, so a rebuild
   * interrupted by eviction is visible as an unfinished index rather than
   * silently reported as ready.
   */
  async rebuild(
    sources: readonly SearchRowSourceV1[],
  ): Promise<SearchRebuildOutcomeV1> {
    this.open();
    this.setMeta(REBUILDING_KEY, "1");
    this.sql.exec(`DELETE FROM ${ROWS_TABLE}`);
    this.sql.exec(`DELETE FROM ${KEYS_TABLE}`);
    this.setMeta(TRUNCATED_KEY, undefined);
    let indexedRows = 0;
    try {
      for (const source of sources) {
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await source.page(cursor);
          indexedRows += this.insert(
            page.rows.filter((row) => row.botId === source.botId),
          );
          cursor = page.nextCursor;
          pages += 1;
          // A Bot cannot page for ever: the run index is bounded, and a source
          // that never stops offering pages is a fault, not a large Bot.
        } while (cursor && pages < 10_000);
      }
    } finally {
      this.setMeta(REBUILDING_KEY, undefined);
    }
    return { indexedRows, bots: sources.length, indexState: this.state() };
  }
}
