/**
 * The SQLite side of an Applet: DDL, typed rows, and the change log.
 *
 * Everything here is synchronous against a `SqlStorage`-shaped handle, so the
 * caller can wrap a whole client transaction in `ctx.storage.transactionSync`
 * and so the whole module is testable against any SQLite driver.
 */

import {
  AppletValidationError,
  addColumnStatement,
  createTableStatement,
  decodeValue,
  encodeValue,
  quoteIdentifier,
  schemaFingerprint,
  type SqlValue,
  type TableDefinition,
  type TablesShape,
} from "../schema/index.js";
import type { AppletChangeV1, AppletMutationV1 } from "../protocol/index.js";

/** The subset of Cloudflare's `SqlStorage` the SDK uses. */
export interface AppletSqlStorage {
  exec(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): Array<Record<string, unknown>> };
}

const META_TABLE = "_applet_meta";
const CHANGE_TABLE = "_applet_changes";
/** Retained change-log length; a client further behind gets a full snapshot. */
export const CHANGE_LOG_LIMIT = 2_000;

export interface SchemaState {
  revision: number;
  /** True when this mount changed the declared shape. */
  changed: boolean;
  previousRevision: number;
}

export class AppletStore {
  private readonly sql: AppletSqlStorage;
  readonly tables: TablesShape;
  private cursor = 0;

  constructor(sql: AppletSqlStorage, tables: TablesShape) {
    this.sql = sql;
    this.tables = tables;
  }

  /**
   * Idempotent DDL. Creates the SDK's own tables and every declared table,
   * adds columns declared since the last mount, and reports whether the shape
   * moved so the caller can run `migrate`.
   */
  ensureSchema(): SchemaState {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(META_TABLE)} ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(CHANGE_TABLE)} (` +
        `"seq" INTEGER PRIMARY KEY AUTOINCREMENT, "txnId" TEXT, "tbl" TEXT NOT NULL, ` +
        `"op" TEXT NOT NULL, "rowKey" TEXT NOT NULL, "row" TEXT, "at" TEXT NOT NULL)`,
    );

    for (const [name, definition] of Object.entries(this.tables)) {
      this.sql.exec(createTableStatement(name, definition));
      const existing = new Set(
        this.sql
          .exec(`PRAGMA table_info(${quoteIdentifier(name)})`)
          .toArray()
          .map((column) => String(column.name)),
      );
      for (const [column, spec] of Object.entries(definition.columns)) {
        if (existing.has(column)) continue;
        this.sql.exec(addColumnStatement(name, column, spec));
      }
    }

    this.cursor = Number(
      this.sql
        .exec(`SELECT MAX("seq") AS seq FROM ${quoteIdentifier(CHANGE_TABLE)}`)
        .toArray()[0]?.seq ?? 0,
    );

    const fingerprint = schemaFingerprint(this.tables);
    const storedFingerprint = this.readMeta("schema:fingerprint");
    const previousRevision = Number(this.readMeta("schema:revision") ?? 0);
    if (storedFingerprint === fingerprint) {
      return { revision: previousRevision, changed: false, previousRevision };
    }
    const revision = previousRevision + 1;
    this.writeMeta("schema:fingerprint", fingerprint);
    this.writeMeta("schema:revision", String(revision));
    return { revision, changed: true, previousRevision };
  }

  private readMeta(key: string): string | undefined {
    const rows = this.sql
      .exec(
        `SELECT "value" FROM ${quoteIdentifier(META_TABLE)} WHERE "key" = ?`,
        key,
      )
      .toArray();
    return rows.length === 0 ? undefined : String(rows[0]!.value);
  }

  private writeMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO ${quoteIdentifier(META_TABLE)} ("key", "value") VALUES (?, ?) ` +
        `ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
      key,
      value,
    );
  }

  get lastChangeId(): number {
    return this.cursor;
  }

  /** Fail closed on a table the Applet did not declare. */
  private definition(table: string): TableDefinition {
    const definition = this.tables[table];
    if (!definition) {
      throw new AppletValidationError(`Unknown table "${table}"`);
    }
    return definition;
  }

  private decodeRow(
    definition: TableDefinition,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [column, spec] of Object.entries(definition.columns)) {
      row[column] = decodeValue(spec.definition, raw[column]);
    }
    return row;
  }

  private encodeInsert(
    table: string,
    definition: TableDefinition,
    values: Record<string, unknown>,
    suppliedKey?: string,
  ): { key: string; columns: string[]; bindings: SqlValue[] } {
    for (const column of Object.keys(values)) {
      if (!Object.hasOwn(definition.columns, column)) {
        throw new AppletValidationError(`Unknown column "${table}.${column}"`);
      }
    }
    const columns: string[] = [];
    const bindings: SqlValue[] = [];
    let key = suppliedKey;
    for (const [column, spec] of Object.entries(definition.columns)) {
      const meta = spec.definition;
      let value = values[column];
      if (column === definition.primaryKey) {
        value =
          (value as string | undefined) ?? suppliedKey ?? crypto.randomUUID();
        key = value as string;
      } else if (value === undefined) {
        if (meta.hasDefault) value = meta.defaultValue;
        else if (meta.optional) value = null;
        else {
          throw new AppletValidationError(
            `Column "${table}.${column}" is required`,
          );
        }
      }
      columns.push(column);
      bindings.push(encodeValue(`${table}.${column}`, meta, value));
    }
    return { key: key!, columns, bindings };
  }

  insert(
    table: string,
    values: Record<string, unknown>,
    txnId?: string,
  ): AppletChangeV1 {
    const definition = this.definition(table);
    const { key, columns, bindings } = this.encodeInsert(
      table,
      definition,
      values,
    );
    this.sql.exec(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`,
      ...bindings,
    );
    const row = this.read(table, key);
    if (!row)
      throw new AppletValidationError(`Insert into "${table}" did not persist`);
    return this.log({ table, op: "insert", key, row }, txnId);
  }

  update(
    table: string,
    key: string,
    patch: Record<string, unknown>,
    txnId?: string,
  ): AppletChangeV1 | undefined {
    const definition = this.definition(table);
    const assignments: string[] = [];
    const bindings: SqlValue[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (!Object.hasOwn(definition.columns, column)) {
        throw new AppletValidationError(`Unknown column "${table}.${column}"`);
      }
      if (column === definition.primaryKey) {
        throw new AppletValidationError(
          `Column "${table}.${column}" is the key`,
        );
      }
      assignments.push(`${quoteIdentifier(column)} = ?`);
      bindings.push(
        encodeValue(
          `${table}.${column}`,
          definition.columns[column]!.definition,
          value,
        ),
      );
    }
    if (assignments.length === 0) return undefined;
    if (!this.read(table, key)) return undefined;
    this.sql.exec(
      `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(", ")} ` +
        `WHERE ${quoteIdentifier(definition.primaryKey)} = ?`,
      ...bindings,
      key,
    );
    const row = this.read(table, key);
    if (!row) return undefined;
    return this.log({ table, op: "update", key, row }, txnId);
  }

  delete(
    table: string,
    key: string,
    txnId?: string,
  ): AppletChangeV1 | undefined {
    const definition = this.definition(table);
    if (!this.read(table, key)) return undefined;
    this.sql.exec(
      `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(definition.primaryKey)} = ?`,
      key,
    );
    return this.log({ table, op: "delete", key }, txnId);
  }

  read(table: string, key: string): Record<string, unknown> | undefined {
    const definition = this.definition(table);
    const rows = this.sql
      .exec(
        `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(definition.primaryKey)} = ? LIMIT 1`,
        key,
      )
      .toArray();
    return rows.length === 0 ? undefined : this.decodeRow(definition, rows[0]!);
  }

  /** Every row, or the rows whose declared columns all equal `filter`. */
  select(
    table: string,
    filter?: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const definition = this.definition(table);
    const clauses: string[] = [];
    const bindings: SqlValue[] = [];
    for (const [column, value] of Object.entries(filter ?? {})) {
      if (!Object.hasOwn(definition.columns, column)) {
        throw new AppletValidationError(`Unknown column "${table}.${column}"`);
      }
      const encoded = encodeValue(
        `${table}.${column}`,
        definition.columns[column]!.definition,
        value,
      );
      if (encoded === null) {
        clauses.push(`${quoteIdentifier(column)} IS NULL`);
      } else {
        clauses.push(`${quoteIdentifier(column)} = ?`);
        bindings.push(encoded);
      }
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return this.sql
      .exec(`SELECT * FROM ${quoteIdentifier(table)}${where}`, ...bindings)
      .toArray()
      .map((row) => this.decodeRow(definition, row));
  }

  /** Apply one client transaction. The caller wraps this in a SQL transaction. */
  applyMutations(
    mutations: AppletMutationV1[],
    txnId?: string,
  ): AppletChangeV1[] {
    return mutations.map((mutation) => {
      const change =
        mutation.op === "insert"
          ? this.insert(
              mutation.table,
              mutation.key === undefined
                ? (mutation.value ?? {})
                : {
                    ...(mutation.value ?? {}),
                    [this.definition(mutation.table).primaryKey]: mutation.key,
                  },
              txnId,
            )
          : mutation.op === "update"
            ? this.update(
                mutation.table,
                mutation.key!,
                mutation.value ?? {},
                txnId,
              )
            : this.delete(mutation.table, mutation.key!, txnId);
      if (!change) {
        throw new AppletValidationError(
          `Row "${mutation.key}" is not in "${mutation.table}"`,
        );
      }
      return change;
    });
  }

  private log(change: AppletChangeV1, txnId?: string): AppletChangeV1 {
    this.sql.exec(
      `INSERT INTO ${quoteIdentifier(CHANGE_TABLE)} ("txnId", "tbl", "op", "rowKey", "row", "at") VALUES (?, ?, ?, ?, ?, ?)`,
      txnId ?? null,
      change.table,
      change.op,
      change.key,
      change.row === undefined ? null : JSON.stringify(change.row),
      new Date().toISOString(),
    );
    this.cursor = Number(
      this.sql
        .exec(`SELECT MAX("seq") AS seq FROM ${quoteIdentifier(CHANGE_TABLE)}`)
        .toArray()[0]!.seq,
    );
    this.trim();
    return change;
  }

  private trim(): void {
    if (this.cursor <= CHANGE_LOG_LIMIT) return;
    this.sql.exec(
      `DELETE FROM ${quoteIdentifier(CHANGE_TABLE)} WHERE "seq" <= ?`,
      this.cursor - CHANGE_LOG_LIMIT,
    );
  }

  /** The whole state, table by table, in declaration order. */
  snapshot(): Record<string, Array<Record<string, unknown>>> {
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const name of Object.keys(this.tables))
      tables[name] = this.select(name);
    return tables;
  }

  /**
   * Changes after `cursor`, or `undefined` when the log no longer reaches back
   * that far and the client must take a full snapshot instead.
   */
  changesSince(cursor: number): AppletChangeV1[] | undefined {
    if (cursor > this.cursor) return undefined;
    if (cursor === this.cursor) return [];
    const oldest = Number(
      this.sql
        .exec(`SELECT MIN("seq") AS seq FROM ${quoteIdentifier(CHANGE_TABLE)}`)
        .toArray()[0]?.seq ?? 0,
    );
    if (oldest === 0 || oldest > cursor + 1) return undefined;
    return this.sql
      .exec(
        `SELECT "tbl", "op", "rowKey", "row" FROM ${quoteIdentifier(CHANGE_TABLE)} WHERE "seq" > ? ORDER BY "seq" ASC`,
        cursor,
      )
      .toArray()
      .map((entry) => {
        const change: AppletChangeV1 = {
          table: String(entry.tbl),
          op: String(entry.op) as AppletChangeV1["op"],
          key: String(entry.rowKey),
        };
        if (entry.row !== null && entry.row !== undefined) {
          change.row = JSON.parse(String(entry.row)) as Record<string, unknown>;
        }
        return change;
      });
  }
}
