/**
 * A `bun:sqlite` handle shaped like Cloudflare's `SqlStorage`, so `AppletStore`
 * — the whole DDL, row-coding, and change-log surface — is testable without
 * workerd. The Durable Object's own semantics are covered by the Miniflare
 * spike and the `applet dev` test instead.
 */
import { Database } from "bun:sqlite";

import type { AppletSqlStorage } from "../src/server/store.js";

export interface TestSql extends AppletSqlStorage {
  database: Database;
  transactionSync<T>(closure: () => T): T;
}

export function createTestSql(database = new Database(":memory:")): TestSql {
  return {
    database,
    exec(query: string, ...bindings: unknown[]) {
      const rows = database.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Array<Record<string, unknown>> };
    },
    transactionSync<T>(closure: () => T): T {
      return database.transaction(closure)();
    },
  };
}
