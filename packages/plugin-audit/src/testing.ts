// A fake `AuditSqlV1`, and a fake outbox storage, for unit tests.
//
// The SQL fake is not an SQL engine. It recognises exactly the statements
// `AuditStoreV1` issues and answers them from JavaScript arrays. That is
// enough to hold the module's real logic to account — idempotency on
// `(botId, runId, occurrenceId)`, both eviction bounds and their durable
// marker, purge, filters and paging — while `audit.workerd.ts` proves the same
// module against a real table on `ctx.storage.sql`.
import type { AuditSqlCursorV1, AuditSqlV1, AuditSqlValueV1 } from "./store.js";
import type { AuditOutboxStorageV1 } from "./bot.js";

interface FakeRow extends Record<string, AuditSqlValueV1> {
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

const COLUMNS = [
  "bot_id",
  "run_id",
  "occurrence_id",
  "turn",
  "step",
  "ordinal",
  "effect_id",
  "at",
  "kind",
  "target",
  "tool_name",
  "argument_digest",
  "preview",
  "outcome",
  "exit_code",
  "duration_ms",
  "bytes_out",
] as const;

function cursor<Row extends Record<string, AuditSqlValueV1>>(
  rows: Row[],
): AuditSqlCursorV1<Row> {
  return { toArray: () => rows };
}

function order(left: FakeRow, right: FakeRow): number {
  return (
    left.at.localeCompare(right.at) ||
    left.bot_id.localeCompare(right.bot_id) ||
    left.run_id.localeCompare(right.run_id) ||
    left.occurrence_id.localeCompare(right.occurrence_id)
  );
}

export class FakeAuditSql implements AuditSqlV1 {
  /**
   * One row list per table, because a rebuild fills a shadow table and swaps
   * it in: a fake with a single list could not tell the two apart and would
   * report the swap as working whatever the store did.
   */
  private tables = new Map<string, FakeRow[]>([["audit_entries", []]]);
  private meta = new Map<string, string>();
  /** Every statement the module issued, for tests that assert on shape. */
  readonly statements: string[] = [];

  /** The table one statement names, defaulting to the live one. */
  private static table(sql: string): string {
    return (
      /(?:FROM|INTO|TABLE(?: IF NOT EXISTS)?(?: IF EXISTS)?) (audit_entries(?:_rebuild)?)/.exec(
        sql,
      )?.[1] ?? "audit_entries"
    );
  }

  private rowsIn(table: string): FakeRow[] {
    const rows = this.tables.get(table);
    if (rows) return rows;
    const created: FakeRow[] = [];
    this.tables.set(table, created);
    return created;
  }

  exec<Row extends Record<string, AuditSqlValueV1>>(
    query: string,
    ...bindings: unknown[]
  ): AuditSqlCursorV1<Row> {
    this.statements.push(query);
    const sql = query.replace(/\s+/g, " ").trim();
    const answer = (rows: unknown[]) => cursor(rows as Row[]);
    const table = FakeAuditSql.table(sql);

    const renamed = /^ALTER TABLE (\S+) RENAME TO (\S+)$/.exec(sql);
    if (renamed) {
      this.tables.set(renamed[2]!, this.rowsIn(renamed[1]!));
      this.tables.delete(renamed[1]!);
      return answer([]);
    }
    if (sql.startsWith("DROP TABLE")) {
      this.tables.delete(table);
      return answer([]);
    }
    if (sql.startsWith("CREATE TABLE")) {
      if (!sql.includes("IF NOT EXISTS")) this.tables.set(table, []);
      else this.rowsIn(table);
      return answer([]);
    }
    if (sql.startsWith("CREATE") || sql.startsWith("DROP")) return answer([]);

    if (sql.startsWith("SELECT value FROM audit_meta")) {
      const value = this.meta.get(String(bindings[0]));
      return answer(value === undefined ? [] : [{ value }]);
    }
    if (sql.startsWith("INSERT INTO audit_meta")) {
      this.meta.set(String(bindings[0]), String(bindings[1]));
      return answer([]);
    }
    if (sql.startsWith("DELETE FROM audit_meta")) {
      this.meta.delete(String(bindings[0]));
      return answer([]);
    }
    if (sql.startsWith("INSERT INTO audit_entries")) {
      const row = Object.fromEntries(
        COLUMNS.map((column, index) => [column, bindings[index] ?? null]),
      ) as FakeRow;
      this.rowsIn(table).push(row);
      return answer([]);
    }
    if (sql.startsWith("SELECT count(*) AS n FROM audit_entries")) {
      return answer([{ n: this.filtered(table, sql, bindings).length }]);
    }
    if (sql.startsWith("SELECT bot_id, run_id, occurrence_id FROM")) {
      const limit = Number(bindings[0]);
      return answer(
        [...this.rowsIn(table)]
          .sort(order)
          .slice(0, limit)
          .map((row) => ({
            bot_id: row.bot_id,
            run_id: row.run_id,
            occurrence_id: row.occurrence_id,
          })),
      );
    }
    if (sql.startsWith("DELETE FROM audit_entries WHERE at <")) {
      this.tables.set(
        table,
        this.rowsIn(table).filter((row) => row.at >= String(bindings[0])),
      );
      return answer([]);
    }
    if (
      sql.startsWith(
        "DELETE FROM audit_entries WHERE bot_id = ? AND run_id = ? AND occurrence_id = ?",
      )
    ) {
      this.tables.set(
        table,
        this.rowsIn(table).filter(
          (row) =>
            !(
              row.bot_id === bindings[0] &&
              row.run_id === bindings[1] &&
              row.occurrence_id === bindings[2]
            ),
        ),
      );
      return answer([]);
    }
    if (sql.startsWith("DELETE FROM audit_entries WHERE bot_id = ?")) {
      this.tables.set(
        table,
        this.rowsIn(table).filter((row) => row.bot_id !== bindings[0]),
      );
      return answer([]);
    }
    if (sql === "DELETE FROM audit_entries") {
      this.tables.set(table, []);
      return answer([]);
    }
    if (sql.startsWith("SELECT * FROM audit_entries")) {
      const descending = [...this.filtered(table, sql, bindings)].sort(
        (left, right) => -order(left, right),
      );
      if (!sql.includes("LIMIT")) return answer(descending);
      const limit = Number(bindings[bindings.length - 2]);
      const offset = Number(bindings[bindings.length - 1]);
      return answer(descending.slice(offset, offset + limit));
    }
    throw new Error(`FakeAuditSql does not recognise: ${sql}`);
  }

  /** Applies the `WHERE bot_id/kind/target` clauses the store builds. */
  private filtered(
    table: string,
    sql: string,
    bindings: unknown[],
  ): FakeRow[] {
    const values = [...bindings];
    const where = /WHERE (.+?)(?: ORDER BY| LIMIT|$)/.exec(sql)?.[1] ?? "";
    if (where.startsWith("at <")) {
      return this.rowsIn(table).filter((row) => row.at < String(values[0]));
    }
    const predicates: Array<(row: FakeRow) => boolean> = [];
    for (const clause of where.split(" AND ").filter(Boolean)) {
      const column = clause.split(" ")[0] as keyof FakeRow;
      if (!COLUMNS.includes(column as (typeof COLUMNS)[number])) continue;
      const expected = String(values.shift());
      predicates.push((row) => String(row[column]) === expected);
    }
    return this.rowsIn(table).filter((row) =>
      predicates.every((predicate) => predicate(row)),
    );
  }
}

/** An in-memory `AuditOutboxStorageV1`. */
export class FakeAuditOutboxStorage implements AuditOutboxStorageV1 {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    // Durable Object storage round-trips through structured clone, so a test
    // that shared an object reference would prove less than production does.
    return value === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(value)) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}
