// A fake `SearchSqlV1` for unit tests.
//
// It is not an SQL engine. It recognises exactly the statements
// `SearchIndexV1` issues and answers them from JavaScript maps, with a
// deliberately naive substring matcher standing in for FTS5. That is enough to
// hold the module's real logic to account — idempotency on
// `(botId, runId, seq)`, quota eviction and its durable marker, purge, kind
// and archive filtering, paging — while the workerd test proves the same
// module against the real FTS5 table on `ctx.storage.sql`.
import type {
  SearchSqlCursorV1,
  SearchSqlV1,
  SearchSqlValueV1,
} from "./index-store.js";

interface FakeRow {
  body: string;
  bot_id: string;
  run_id: string;
  seq: number;
  kind: string;
  at: string;
}

function cursor<Row extends Record<string, SearchSqlValueV1>>(
  rows: Row[],
): SearchSqlCursorV1<Row> {
  return { toArray: () => rows };
}

/** Mirrors `searchMatchExpressionV1`'s output closely enough to match on. */
function matches(body: string, expression: string): boolean {
  const tokens = [...expression.matchAll(/"((?:[^"]|"")*)"(\*?)/g)].map(
    (match) => ({
      token: match[1]!.replaceAll('""', '"').toLowerCase(),
      prefix: match[2] === "*",
    }),
  );
  if (tokens.length === 0) return false;
  const words = body
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  return tokens.every(({ token, prefix }) =>
    words.some((word) => (prefix ? word.startsWith(token) : word === token)),
  );
}

export class FakeSearchSql implements SearchSqlV1 {
  private rows: FakeRow[] = [];
  private meta = new Map<string, string>();
  /** Every statement the module issued, for tests that assert on shape. */
  readonly statements: string[] = [];

  exec<Row extends Record<string, SearchSqlValueV1>>(
    query: string,
    ...bindings: unknown[]
  ): SearchSqlCursorV1<Row> {
    this.statements.push(query);
    const sql = query.replace(/\s+/g, " ").trim();
    const answer = (rows: unknown[]) => cursor(rows as Row[]);

    if (sql.startsWith("CREATE") || sql.startsWith("DROP")) return answer([]);

    if (sql.startsWith("SELECT value FROM search_meta")) {
      const value = this.meta.get(String(bindings[0]));
      return answer(value === undefined ? [] : [{ value }]);
    }
    if (sql.startsWith("INSERT INTO search_meta")) {
      this.meta.set(String(bindings[0]), String(bindings[1]));
      return answer([]);
    }
    if (sql.startsWith("DELETE FROM search_meta")) {
      this.meta.delete(String(bindings[0]));
      return answer([]);
    }
    if (
      sql.startsWith(
        "SELECT count(*) AS n FROM search_keys WHERE bot_id = ? AND run_id = ? AND seq = ?",
      )
    ) {
      return answer([{ n: this.key(bindings) ? 1 : 0 }]);
    }
    if (
      sql.startsWith("SELECT count(*) AS n FROM search_keys WHERE bot_id = ?")
    ) {
      return answer([
        { n: this.rows.filter((row) => row.bot_id === bindings[0]).length },
      ]);
    }
    if (sql.startsWith("SELECT count(*) AS n FROM search_keys")) {
      return answer([{ n: this.rows.length }]);
    }
    if (sql.startsWith("INSERT INTO search_rows")) {
      this.rows.push({
        body: String(bindings[0]),
        bot_id: String(bindings[1]),
        run_id: String(bindings[2]),
        seq: Number(bindings[3]),
        kind: String(bindings[4]),
        at: String(bindings[5]),
      });
      return answer([]);
    }
    if (sql.startsWith("INSERT INTO search_keys")) return answer([]);
    if (
      sql.startsWith("SELECT bot_id, run_id, seq FROM search_keys ORDER BY at")
    ) {
      const limit = Number(bindings[0]);
      return answer(
        [...this.rows]
          .sort(
            (left, right) =>
              left.at.localeCompare(right.at) ||
              left.bot_id.localeCompare(right.bot_id) ||
              left.run_id.localeCompare(right.run_id) ||
              left.seq - right.seq,
          )
          .slice(0, limit)
          .map((row) => ({
            bot_id: row.bot_id,
            run_id: row.run_id,
            seq: row.seq,
          })),
      );
    }
    if (
      sql.startsWith("DELETE FROM search_rows WHERE bot_id = ? AND run_id") ||
      sql.startsWith("DELETE FROM search_keys WHERE bot_id = ? AND run_id")
    ) {
      this.rows = this.rows.filter(
        (row) =>
          !(
            row.bot_id === bindings[0] &&
            row.run_id === bindings[1] &&
            row.seq === Number(bindings[2])
          ),
      );
      return answer([]);
    }
    if (
      sql.startsWith("DELETE FROM search_rows WHERE bot_id = ?") ||
      sql.startsWith("DELETE FROM search_keys WHERE bot_id = ?")
    ) {
      this.rows = this.rows.filter((row) => row.bot_id !== bindings[0]);
      return answer([]);
    }
    if (
      sql === "DELETE FROM search_rows" ||
      sql === "DELETE FROM search_keys"
    ) {
      this.rows = [];
      return answer([]);
    }
    if (sql.startsWith("SELECT bot_id, run_id, seq, kind, at,")) {
      return answer(this.select(sql, bindings));
    }
    throw new Error(`FakeSearchSql does not recognise: ${sql}`);
  }

  private key(bindings: unknown[]): FakeRow | undefined {
    return this.rows.find(
      (row) =>
        row.bot_id === bindings[0] &&
        row.run_id === bindings[1] &&
        row.seq === Number(bindings[2]),
    );
  }

  private select(sql: string, bindings: unknown[]): unknown[] {
    const values = [...bindings];
    const expression = String(values.shift());
    const kindCount = (sql.match(/kind IN \(([^)]*)\)/)?.[1] ?? "").split(
      ",",
    ).length;
    const kinds = values.splice(0, kindCount).map(String);
    const botId = sql.includes("AND bot_id = ?")
      ? String(values.shift())
      : undefined;
    const excludedCount = Number(
      (sql.match(/bot_id NOT IN \(([^)]*)\)/)?.[1] ?? "")
        .split(",")
        .filter((part) => part.trim() === "?").length,
    );
    const excluded = values.splice(0, excludedCount).map(String);
    const offset = Number(values.pop());
    const limit = Number(values.pop());
    return this.rows
      .filter(
        (row) =>
          matches(row.body, expression) &&
          kinds.includes(row.kind) &&
          (botId === undefined || row.bot_id === botId) &&
          !excluded.includes(row.bot_id),
      )
      .sort(
        (left, right) =>
          left.at.localeCompare(right.at) ||
          left.bot_id.localeCompare(right.bot_id) ||
          left.run_id.localeCompare(right.run_id) ||
          left.seq - right.seq,
      )
      .slice(offset, offset + limit)
      .map((row) => ({
        bot_id: row.bot_id,
        run_id: row.run_id,
        seq: row.seq,
        kind: row.kind,
        at: row.at,
        snippet: row.body.slice(0, 120),
      }));
  }
}
