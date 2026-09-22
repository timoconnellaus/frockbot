// Owner-local SQLite schema for canonical Memory. One initializer per owner.
// Cloudflare FTS5 is the lexical index; Vectorize stays a derived job.

import type { MemorySqlV1 } from "./sql.js";

const SCHEMA_VERSION = "1";

export function openMemorySchemaV1(sql: MemorySqlV1): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_scope (
      scope_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      invalidation_epoch INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_item (
      scope_key TEXT NOT NULL,
      id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      text TEXT NOT NULL,
      subject_key TEXT,
      predicate_key TEXT,
      occurred_at TEXT,
      recorded_at TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      created_by TEXT NOT NULL,
      confidence REAL,
      PRIMARY KEY (scope_key, id))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_item_active
      ON memory_item (scope_key, subject_key, occurred_at)
      WHERE status = 'active'`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_item_time
      ON memory_item (scope_key, recorded_at, id)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_item_key
      ON memory_item (scope_key, canonical_key, status)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_source (
      scope_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      safe_excerpt TEXT,
      PRIMARY KEY (scope_key, source_id, source_revision))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_evidence (
      scope_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      PRIMARY KEY (scope_key, item_id, source_id, source_revision))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_evidence_source
      ON memory_evidence (scope_key, source_id, source_revision)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_relation (
      scope_key TEXT NOT NULL,
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      to_id TEXT NOT NULL,
      PRIMARY KEY (scope_key, from_id, relation, to_id))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_derivation (
      scope_key TEXT NOT NULL,
      derived_id TEXT NOT NULL,
      leaf_item_id TEXT NOT NULL,
      leaf_generation INTEGER NOT NULL,
      PRIMARY KEY (scope_key, derived_id, leaf_item_id))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_derivation_leaf
      ON memory_derivation (scope_key, leaf_item_id)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_suppression (
      scope_key TEXT NOT NULL,
      exact_key TEXT NOT NULL,
      source_lineage TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      PRIMARY KEY (scope_key, exact_key, source_lineage))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_receipt (
      scope_key TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (scope_key, operation_key))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_job (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      source_ref TEXT,
      input_generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      claim_token TEXT,
      effect_ref TEXT)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_job_due
      ON memory_job (state, next_attempt_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_projection (
      scope_key TEXT NOT NULL,
      name TEXT NOT NULL,
      generation INTEGER NOT NULL,
      policy_version INTEGER NOT NULL,
      checked_invalidation_epoch INTEGER NOT NULL,
      body TEXT NOT NULL,
      manifest TEXT NOT NULL,
      PRIMARY KEY (scope_key, name))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_index_intent (
      scope_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_generation INTEGER NOT NULL,
      operation TEXT NOT NULL,
      vector_id TEXT NOT NULL,
      state TEXT NOT NULL,
      mutation_id TEXT,
      next_attempt_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, item_id, item_generation, operation))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_index_intent_due
      ON memory_index_intent (state, next_attempt_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_source_retention (
      scope_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      captured_text TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      obligation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (scope_key, source_id, source_revision))`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_source_retention_obligation
      ON memory_source_retention (obligation_id)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_outbox (
      id TEXT PRIMARY KEY,
      destination_scope_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acked_at TEXT)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_outbox_due
      ON memory_outbox (state, created_at)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_job_result (
      job_id TEXT PRIMARY KEY,
      body TEXT NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS memory_vector_ledger (
      vector_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_generation INTEGER NOT NULL,
      operation TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      mutation_id TEXT,
      state TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS memory_vector_ledger_item
      ON memory_vector_ledger (scope_key, item_id, item_generation)`,
  );
  sql.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_item_fts USING fts5(
      text,
      scope_key UNINDEXED,
      id UNINDEXED,
      tokenize='unicode61')`,
  );
  ensureColumnV1(sql, "memory_job", "principal", "TEXT");
  ensureColumnV1(sql, "memory_index_intent", "claim_token", "TEXT");
  const existing = sql
    .exec<{ value: string }>(
      "SELECT value FROM memory_meta WHERE key = 'schema-version'",
    )
    .toArray();
  if (!existing[0]) {
    sql.exec(
      "INSERT INTO memory_meta (key, value) VALUES ('schema-version', ?)",
      SCHEMA_VERSION,
    );
  }
}

export function memorySchemaVersionV1(sql: MemorySqlV1): string | undefined {
  const rows = sql
    .exec<{ value: string }>(
      "SELECT value FROM memory_meta WHERE key = 'schema-version'",
    )
    .toArray();
  return rows[0]?.value;
}

function ensureColumnV1(
  sql: MemorySqlV1,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray();
  if (rows.some((row) => row.name === column)) return;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
