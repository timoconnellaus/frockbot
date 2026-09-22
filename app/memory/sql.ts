// The SQL surface the canonical Memory engine consumes: exactly what
// `ctx.storage.sql` offers, so tests can supply bun:sqlite and the Durable
// Object type never reaches this module.

/** Exactly the column types SQLite storage returns. */
export type MemorySqlValueV1 = ArrayBuffer | string | number | null;

export interface MemorySqlCursorV1<
  Row extends Record<string, MemorySqlValueV1>,
> {
  toArray(): Row[];
}

export interface MemorySqlV1 {
  exec<Row extends Record<string, MemorySqlValueV1>>(
    query: string,
    // eslint-disable-next-line -- `SqlStorage.exec` declares `any[]`; a
    // narrower parameter type here would stop `ctx.storage.sql` satisfying
    // this interface at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...bindings: any[]
  ): MemorySqlCursorV1<Row>;
}

/** One owner's SQLite transaction and optional durable wakeup. */
export interface MemorySqlStorageV1 {
  sql: MemorySqlV1;
  transactionSync<T>(callback: () => T): T;
  getAlarm?(): number | null;
  setAlarm?(scheduledTime: number): void;
}

/**
 * Turns a person's words into an FTS5 MATCH expression.
 *
 * Every token is quoted, so FTS operators in the query are searched for rather
 * than executed. Copied from the User transcript index for the same reason:
 * a model-supplied query is inbound.
 */
export function memoryMatchExpressionV1(query: string): string | undefined {
  const tokens = query
    .slice(0, 500)
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
