// Canonical Memory operations over owner-local SQLite.
//
// Mutations, receipts, FTS and pending jobs commit in one transactionSync.
// External embeddings, model calls and other Durable Object RPCs stay out.
// The owner's existing alarm is armed after that commit with the due time
// already on the job row, so a crash between them still has a durable
// wakeup: the next owner access reads the due index and re-arms.

import { refuseMemorySecretV1 } from "./secrets.js";
import { openMemorySchemaV1 } from "./schema.js";
import {
  memoryMatchExpressionV1,
  type MemorySqlStorageV1,
  type MemorySqlV1,
} from "./sql.js";
import {
  authorizeMemoryScopeV1,
  createdByPrincipalV1,
  decodeMemoryScopeKeyV1,
  memoryCanonicalKeyV1,
  memoryScopeKeyV1,
  MEMORY_BROWSE_SECTIONS_V1,
  MEMORY_JOB_WAKEUP_MS_V1,
  MEMORY_MAX_BROWSE_PAGE_V1,
  MEMORY_MAX_EXPAND_REFS_V1,
  MEMORY_MAX_LEAF_MANIFEST_V1,
  MEMORY_MAX_SOURCE_EXCERPT_V1,
  MEMORY_MAX_SOURCES_V1,
  MEMORY_MAX_TEXT_CHARS_V1,
  MEMORY_RECALL_PAGE_V1,
  type MemoryBrowseRequestV1,
  type MemoryBrowseResultV1,
  type MemoryBrowseSectionV1,
  type MemoryCompletenessV1,
  type MemoryEngineScopeKindV1,
  type MemoryEvidenceV1,
  type MemoryExpandRequestV1,
  type MemoryExpandResultV1,
  type MemoryForgetReceiptV1,
  type MemoryForgetRequestV1,
  type MemoryForgetResultV1,
  type MemoryHitV1,
  type MemoryItemKindV1,
  type MemoryItemRecordV1,
  type MemoryItemStatusV1,
  type MemoryLeafManifestV1,
  type MemoryEngineOmissionV1,
  type MemoryOperationsV1,
  type MemoryPreparedCoreRequestV1,
  type MemoryPreparedCoreResultV1,
  type MemoryRecallRequestV1,
  type MemoryRecallResultV1,
  type MemoryScopeRefV1,
  type MemorySourceInputV1,
  type MemorySourceKindV1,
  type MemorySourceLocatorV1,
  type MemoryWriteReceiptV1,
  type MemoryWriteRequestV1,
  type MemoryWriteResultV1,
} from "./records.js";

type ItemRow = {
  scope_key: string;
  id: string;
  generation: number;
  kind: string;
  status: string;
  canonical_key: string;
  text: string;
  subject_key: string | null;
  predicate_key: string | null;
  occurred_at: string | null;
  recorded_at: string;
  valid_from: string | null;
  valid_to: string | null;
  created_by: string;
  confidence: number | null;
};

export interface MemoryEngineOptionsV1 {
  storage: MemorySqlStorageV1;
  now?: () => Date;
  /** Scopes this owner stores. Omit to accept every kind in isolated tests. */
  ownedKinds?: readonly MemoryEngineScopeKindV1[];
  /**
   * Test-only: throw inside the owner transaction after this step so a
   * crash/rollback can be driven without a second store. Production omits it.
   */
  onTransactionStep?: (step: string) => void;
}

export class MemoryEngineV1 implements MemoryOperationsV1 {
  #sql: MemorySqlV1;
  #storage: MemorySqlStorageV1;
  #now: () => Date;
  #ownedKinds?: readonly MemoryEngineScopeKindV1[];
  #onStep?: (step: string) => void;
  #opened = false;

  constructor(options: MemoryEngineOptionsV1) {
    this.#storage = options.storage;
    this.#sql = options.storage.sql;
    this.#now = options.now ?? (() => new Date());
    this.#ownedKinds = options.ownedKinds;
    this.#onStep = options.onTransactionStep;
  }

  open(): void {
    if (this.#opened) return;
    openMemorySchemaV1(this.#sql);
    this.#opened = true;
  }

  /**
   * Earliest due job or index intent. The Bot/User alarm owner reads this
   * after eviction; a post-commit setAlarm is the fast path, not the only one.
   */
  nextWakeupAt(): number | undefined {
    this.open();
    const job = this.#sql
      .exec<{ next_attempt_at: number }>(
        `SELECT next_attempt_at FROM memory_job
         WHERE state IN ('pending', 'claimed')
         ORDER BY next_attempt_at ASC LIMIT 1`,
      )
      .toArray()[0];
    const intent = this.#sql
      .exec<{ next_attempt_at: number }>(
        `SELECT next_attempt_at FROM memory_index_intent
         WHERE state = 'pending'
         ORDER BY next_attempt_at ASC LIMIT 1`,
      )
      .toArray()[0];
    const times = [job?.next_attempt_at, intent?.next_attempt_at].filter(
      (value): value is number => typeof value === "number",
    );
    if (times.length === 0) return undefined;
    return Math.min(...times);
  }

  /** Arms the existing owner alarm if a due time is earlier than the current. */
  ensureWakeup(): void {
    const due = this.nextWakeupAt();
    if (due === undefined) return;
    this.arm(due);
  }

  write(request: MemoryWriteRequestV1): MemoryWriteResultV1 {
    const owned = this.refuseOwned(request.scope);
    if (owned) return { status: "refused", reason: owned };
    const authorized = authorizeMemoryScopeV1(request.authority, request.scope);
    if (authorized) return { status: "refused", reason: authorized };
    const text = request.content.trim();
    if (!text || text.length > MEMORY_MAX_TEXT_CHARS_V1) {
      return {
        status: "refused",
        reason: `a fact must be between 1 and ${MEMORY_MAX_TEXT_CHARS_V1} characters`,
      };
    }
    const secret = refuseMemorySecretV1(text);
    if (secret) return { status: "refused", reason: secret.reason };
    const sources = request.sources ?? [];
    if (sources.length > MEMORY_MAX_SOURCES_V1) {
      return {
        status: "refused",
        reason: `an observation may cite at most ${MEMORY_MAX_SOURCES_V1} sources; split it`,
      };
    }
    for (const source of sources) {
      if (
        source.safeExcerpt &&
        source.safeExcerpt.length > MEMORY_MAX_SOURCE_EXCERPT_V1
      ) {
        return {
          status: "refused",
          reason: `a source excerpt must be at most ${MEMORY_MAX_SOURCE_EXCERPT_V1} characters`,
        };
      }
      const excerptSecret = source.safeExcerpt
        ? refuseMemorySecretV1(source.safeExcerpt)
        : undefined;
      if (excerptSecret) {
        return { status: "refused", reason: excerptSecret.reason };
      }
    }
    const kind = request.kind ?? "fact";
    if (
      kind === "observation" &&
      sources.length > MEMORY_MAX_LEAF_MANIFEST_V1
    ) {
      return {
        status: "refused",
        reason: `an observation may depend on at most ${MEMORY_MAX_LEAF_MANIFEST_V1} leaves; split it`,
      };
    }
    const now = this.#now();
    const recordedAt = now.toISOString();
    const scopeKey = memoryScopeKeyV1(request.scope);
    const canonicalKey = memoryCanonicalKeyV1(text);
    const createdBy =
      request.createdBy ?? createdByPrincipalV1(request.authority);
    const itemId = itemIdForOperationV1(request.operationKey);
    try {
      const result = this.#storage.transactionSync(() => {
        this.open();
        this.step("open");
        const existingReceipt = this.receipt(scopeKey, request.operationKey);
        if (existingReceipt) {
          return JSON.parse(existingReceipt) as MemoryWriteResultV1;
        }
        this.ensureScope(scopeKey);
        this.step("scope");
        if (request.replaces) {
          const replaced = this.item(scopeKey, request.replaces);
          if (!replaced || replaced.status !== "active") {
            return {
              status: "refused",
              reason: `no active item "${request.replaces}" exists to correct`,
            } satisfies MemoryWriteResultV1;
          }
          if (
            request.authority.actor === "bot" &&
            replaced.created_by !== createdBy
          ) {
            return {
              status: "refused",
              reason:
                "this Bot cannot rewrite another Bot's evidence; ask the User to correct it",
            } satisfies MemoryWriteResultV1;
          }
        }
        const duplicate = this.activeByKey(scopeKey, canonicalKey);
        if (duplicate && !request.replaces) {
          const receipt: MemoryWriteReceiptV1 = {
            operationKey: request.operationKey,
            itemId: duplicate.id,
            generation: Number(duplicate.generation),
            scope: request.scope,
            duplicate: true,
            suppressedOverride: false,
          };
          const result: MemoryWriteResultV1 = { status: "ok", receipt };
          this.putReceipt(scopeKey, request.operationKey, result);
          return result;
        }
        const suppressed = this.#sql
          .exec<{ n: number }>(
            `SELECT count(*) AS n FROM memory_suppression
             WHERE scope_key = ? AND exact_key = ?`,
            scopeKey,
            canonicalKey,
          )
          .toArray()[0];
        const suppressedOverride = Number(suppressed?.n ?? 0) > 0;
        if (suppressedOverride) {
          this.#sql.exec(
            `DELETE FROM memory_suppression WHERE scope_key = ? AND exact_key = ?`,
            scopeKey,
            canonicalKey,
          );
        }
        this.step("item");
        this.#sql.exec(
          `INSERT INTO memory_item (
            scope_key, id, generation, kind, status, canonical_key, text,
            subject_key, predicate_key, occurred_at, recorded_at, valid_from,
            valid_to, created_by, confidence)
           VALUES (?, ?, 1, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL)`,
          scopeKey,
          itemId,
          kind,
          canonicalKey,
          text,
          request.subjectKey ?? null,
          request.occurredAt ?? recordedAt,
          recordedAt,
          recordedAt,
          createdBy,
        );
        this.upsertFts(scopeKey, itemId, text);
        this.step("fts");
        this.writeSources(scopeKey, itemId, sources);
        this.step("sources");
        if (kind === "observation") {
          this.writeObservationLeaves(scopeKey, itemId, sources);
        }
        if (request.replaces) {
          this.#sql.exec(
            `UPDATE memory_item SET status = 'superseded', valid_to = ?
             WHERE scope_key = ? AND id = ?`,
            recordedAt,
            scopeKey,
            request.replaces,
          );
          this.#sql.exec(
            `DELETE FROM memory_item_fts WHERE scope_key = ? AND id = ?`,
            scopeKey,
            request.replaces,
          );
          this.#sql.exec(
            `INSERT INTO memory_relation (scope_key, from_id, relation, to_id)
             VALUES (?, ?, 'supersedes', ?)`,
            scopeKey,
            itemId,
            request.replaces,
          );
          this.advanceInvalidation(scopeKey);
          this.queueIndexIntent(scopeKey, request.replaces, "delete", now);
        }
        if (request.promotedFrom) {
          this.#sql.exec(
            `INSERT INTO memory_relation (scope_key, from_id, relation, to_id)
             VALUES (?, ?, 'promotedFrom', ?)`,
            scopeKey,
            itemId,
            `${request.promotedFrom.scopeKey}/${request.promotedFrom.itemId}`,
          );
        }
        this.bumpGeneration(scopeKey);
        this.queueIndexIntent(scopeKey, itemId, "upsert", now);
        this.step("jobs");
        const receipt: MemoryWriteReceiptV1 = {
          operationKey: request.operationKey,
          itemId,
          generation: 1,
          scope: request.scope,
          duplicate: false,
          suppressedOverride,
        };
        const result: MemoryWriteResultV1 = { status: "ok", receipt };
        this.putReceipt(scopeKey, request.operationKey, result);
        this.step("receipt");
        return result;
      });
      this.armAfterCommit();
      return result;
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Memory write failed",
      };
    }
  }

  forget(request: MemoryForgetRequestV1): MemoryForgetResultV1 {
    const owned = this.refuseOwned(request.scope);
    if (owned) return { status: "refused", reason: owned };
    const authorized = authorizeMemoryScopeV1(request.authority, request.scope);
    if (authorized) return { status: "refused", reason: authorized };
    const exactKey = request.exactKey
      ? memoryCanonicalKeyV1(request.exactKey)
      : undefined;
    if (!request.itemId && !exactKey) {
      return { status: "refused", reason: "a fact text is required" };
    }
    const scopeKey = memoryScopeKeyV1(request.scope);
    const now = this.#now();
    try {
      const result = this.#storage.transactionSync(() => {
        this.open();
        const existingReceipt = this.receipt(scopeKey, request.operationKey);
        if (existingReceipt) {
          return JSON.parse(existingReceipt) as MemoryForgetResultV1;
        }
        this.ensureScope(scopeKey);
        const target = request.itemId
          ? this.item(scopeKey, request.itemId)
          : this.activeByKey(scopeKey, exactKey ?? "");
        if (!target || target.status !== "active") {
          const empty: MemoryForgetResultV1 = {
            status: "refused",
            reason: request.itemId
              ? `no active item "${request.itemId}" is recorded in this scope`
              : `no fact matching "${request.exactKey}" is recorded in this scope`,
          };
          return empty;
        }
        if (
          request.authority.actor === "bot" &&
          target.created_by !== createdByPrincipalV1(request.authority)
        ) {
          return {
            status: "refused",
            reason:
              "this Bot cannot rewrite another Bot's evidence; ask the User to forget it",
          } satisfies MemoryForgetResultV1;
        }
        this.step("item");
        this.#sql.exec(
          `UPDATE memory_item SET status = 'inactive', valid_to = ?
           WHERE scope_key = ? AND id = ?`,
          now.toISOString(),
          scopeKey,
          target.id,
        );
        this.#sql.exec(
          `DELETE FROM memory_item_fts WHERE scope_key = ? AND id = ?`,
          scopeKey,
          target.id,
        );
        const lineage = this.sourceLineage(scopeKey, target.id);
        this.#sql.exec(
          `INSERT INTO memory_suppression (
            scope_key, exact_key, source_lineage, operation_key)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (scope_key, exact_key, source_lineage)
           DO UPDATE SET operation_key = excluded.operation_key`,
          scopeKey,
          target.canonical_key,
          lineage,
          request.operationKey,
        );
        this.advanceInvalidation(scopeKey);
        this.queueIndexIntent(
          scopeKey,
          target.id,
          "delete",
          now,
          Number(target.generation),
        );
        this.queueJob({
          kind: "view-repair",
          scopeKey,
          sourceRef: target.id,
          inputGeneration: this.scopeGeneration(scopeKey),
          now,
        });
        this.bumpGeneration(scopeKey);
        this.step("jobs");
        const receipt: MemoryForgetReceiptV1 = {
          operationKey: request.operationKey,
          itemId: target.id,
          exactKey: target.canonical_key,
          forgotten: true,
          duplicate: false,
          scope: request.scope,
        };
        const result: MemoryForgetResultV1 = { status: "ok", receipt };
        this.putReceipt(scopeKey, request.operationKey, result);
        this.step("receipt");
        return result;
      });
      this.armAfterCommit();
      return result;
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Memory forget failed",
      };
    }
  }

  recall(request: MemoryRecallRequestV1): MemoryRecallResultV1 {
    const omissions: MemoryEngineOmissionV1[] = [];
    const authorized: MemoryScopeRefV1[] = [];
    for (const scope of request.scopes) {
      const owned = this.refuseOwned(scope);
      if (owned) {
        omissions.push({ reason: owned, scope });
        continue;
      }
      const reason = authorizeMemoryScopeV1(request.authority, scope);
      if (reason) {
        omissions.push({ reason, scope });
        continue;
      }
      authorized.push(scope);
    }
    if (authorized.length === 0) {
      return {
        hits: [],
        status: omissions.length > 0 ? "refused" : "empty",
        omissions,
        membershipRevision: request.authority.membershipRevision,
      };
    }
    this.open();
    const query = request.query.trim();
    if (!query) {
      return {
        hits: [],
        status: "empty",
        omissions,
        membershipRevision: request.authority.membershipRevision,
      };
    }
    const budget = Math.min(
      request.budget ?? MEMORY_RECALL_PAGE_V1,
      MEMORY_RECALL_PAGE_V1,
    );
    const match = memoryMatchExpressionV1(query);
    const exact = memoryCanonicalKeyV1(query);
    const hits: MemoryHitV1[] = [];
    let channelFailed = false;
    for (const scope of authorized) {
      const scopeKey = memoryScopeKeyV1(scope);
      try {
        const byId = this.item(scopeKey, query);
        if (byId && byId.status === "active") {
          hits.push(this.hitOf(byId, 1));
        }
        const byKey = this.activeByKey(scopeKey, exact);
        if (byKey && (!byId || byKey.id !== byId.id)) {
          hits.push(this.hitOf(byKey, 1));
        }
        if (match) {
          const rows = this.#sql
            .exec<{ id: string }>(
              `SELECT memory_item_fts.id AS id FROM memory_item_fts
               JOIN memory_item
                 ON memory_item.scope_key = memory_item_fts.scope_key
                AND memory_item.id = memory_item_fts.id
               WHERE memory_item_fts MATCH ?
                 AND memory_item_fts.scope_key = ?
                 AND memory_item.status = 'active'
               LIMIT ?`,
              match,
              scopeKey,
              budget,
            )
            .toArray();
          for (const row of rows) {
            if (hits.some((hit) => hit.item.id === row.id)) continue;
            const item = this.item(scopeKey, row.id);
            if (item && item.status === "active")
              hits.push(this.hitOf(item, 0.5));
          }
        }
      } catch (error) {
        channelFailed = true;
        omissions.push({
          scope,
          reason:
            error instanceof Error
              ? error.message
              : "lexical recall failed for this scope",
        });
      }
    }
    const filtered = hits.filter((hit) => {
      if (request.filters?.kind && hit.item.kind !== request.filters.kind) {
        return false;
      }
      if (
        request.filters?.subjectKey &&
        hit.item.subjectKey !== request.filters.subjectKey
      ) {
        return false;
      }
      return !this.isSuppressed(
        memoryScopeKeyV1(hit.item.scope),
        hit.item.canonicalKey,
      );
    });
    const page = filtered.slice(0, budget);
    const status: MemoryCompletenessV1 = channelFailed
      ? "unavailable"
      : page.length === 0
        ? "empty"
        : filtered.length > budget
          ? "partial"
          : "complete";
    return {
      hits: page,
      status,
      ...(filtered.length > budget
        ? { cursor: page[page.length - 1]?.item.id }
        : {}),
      omissions,
      membershipRevision: request.authority.membershipRevision,
    };
  }

  expand(request: MemoryExpandRequestV1): MemoryExpandResultV1 {
    this.open();
    const evidence: MemoryEvidenceV1[] = [];
    const omissions: MemoryEngineOmissionV1[] = [];
    const refs = request.sourceRefs.slice(0, MEMORY_MAX_EXPAND_REFS_V1);
    if (request.sourceRefs.length > MEMORY_MAX_EXPAND_REFS_V1) {
      omissions.push({
        reason: `expansion was capped at ${MEMORY_MAX_EXPAND_REFS_V1} references`,
      });
    }
    for (const ref of refs) {
      const owned = this.refuseOwned(ref.scope);
      if (owned) {
        omissions.push({
          reason: owned,
          scope: ref.scope,
          ref: ref.sourceId ?? ref.itemId,
        });
        continue;
      }
      const reason = authorizeMemoryScopeV1(request.authority, ref.scope);
      if (reason) {
        omissions.push({
          reason,
          scope: ref.scope,
          ref: ref.sourceId ?? ref.itemId,
        });
        continue;
      }
      const scopeKey = memoryScopeKeyV1(ref.scope);
      if (ref.itemId) {
        const item = this.item(scopeKey, ref.itemId);
        if (!item || item.status !== "active") {
          omissions.push({
            reason: "that Memory item is unavailable",
            scope: ref.scope,
            ref: ref.itemId,
          });
          continue;
        }
        const rows = this.#sql
          .exec<{
            source_id: string;
            source_revision: string;
            kind: string;
            locator: string;
            safe_excerpt: string | null;
          }>(
            `SELECT memory_source.source_id AS source_id,
                    memory_source.source_revision AS source_revision,
                    memory_source.kind AS kind,
                    memory_source.locator AS locator,
                    memory_source.safe_excerpt AS safe_excerpt
             FROM memory_evidence
             JOIN memory_source
               ON memory_source.scope_key = memory_evidence.scope_key
              AND memory_source.source_id = memory_evidence.source_id
              AND memory_source.source_revision = memory_evidence.source_revision
             WHERE memory_evidence.scope_key = ? AND memory_evidence.item_id = ?`,
            scopeKey,
            ref.itemId,
          )
          .toArray();
        if (rows.length === 0) {
          if (item.kind === "observation") {
            omissions.push({
              reason:
                "the original material is not available to quote; the observation is a synthesis",
              scope: ref.scope,
              ref: ref.itemId,
            });
          }
          continue;
        }
        for (const row of rows) {
          evidence.push(decodeEvidenceV1(ref.itemId, row));
        }
        continue;
      }
      if (!ref.sourceId) {
        omissions.push({
          reason: "expansion needs an item or source id",
          scope: ref.scope,
        });
        continue;
      }
      const source = this.#sql
        .exec<{
          source_id: string;
          source_revision: string;
          kind: string;
          locator: string;
          safe_excerpt: string | null;
        }>(
          `SELECT source_id, source_revision, kind, locator, safe_excerpt
           FROM memory_source
           WHERE scope_key = ? AND source_id = ?${
             ref.sourceRevision ? " AND source_revision = ?" : ""
           }
           LIMIT 1`,
          ...(ref.sourceRevision
            ? [scopeKey, ref.sourceId, ref.sourceRevision]
            : [scopeKey, ref.sourceId]),
        )
        .toArray()[0];
      if (!source) {
        omissions.push({
          reason: "that source is not recorded in an authorized scope",
          scope: ref.scope,
          ref: ref.sourceId,
        });
        continue;
      }
      const linked = this.#sql
        .exec<{ item_id: string }>(
          `SELECT item_id FROM memory_evidence
           WHERE scope_key = ? AND source_id = ? AND source_revision = ?
           LIMIT 1`,
          scopeKey,
          source.source_id,
          source.source_revision,
        )
        .toArray()[0];
      evidence.push(decodeEvidenceV1(linked?.item_id ?? "", source));
    }
    const status: MemoryCompletenessV1 =
      evidence.length === 0 && omissions.length > 0
        ? omissions.every(
            (entry) =>
              entry.reason.includes("not the owner") ||
              entry.reason.includes("not joined") ||
              entry.reason.includes("own Bot"),
          )
          ? "refused"
          : "unavailable"
        : evidence.length === 0
          ? "empty"
          : omissions.length > 0
            ? "partial"
            : "complete";
    return { evidence, omissions, status };
  }

  browse(request: MemoryBrowseRequestV1): MemoryBrowseResultV1 {
    const owned = this.refuseOwned(request.scope);
    if (owned) {
      return {
        sections: [],
        status: "refused",
        omissions: [{ reason: owned, scope: request.scope }],
      };
    }
    const reason = authorizeMemoryScopeV1(request.authority, request.scope);
    if (reason) {
      return {
        sections: [],
        status: "refused",
        omissions: [{ reason, scope: request.scope }],
      };
    }
    this.open();
    const scopeKey = memoryScopeKeyV1(request.scope);
    const epoch = this.invalidationEpoch(scopeKey);
    const projection = request.topic
      ? this.#sql
          .exec<{
            generation: number;
            policy_version: number;
            checked_invalidation_epoch: number;
            body: string;
            manifest: string;
          }>(
            `SELECT generation, policy_version, checked_invalidation_epoch, body, manifest
             FROM memory_projection
             WHERE scope_key = ? AND name = ?`,
            scopeKey,
            `topic:${request.topic}`,
          )
          .toArray()[0]
      : undefined;
    if (projection) {
      if (Number(projection.checked_invalidation_epoch) !== epoch) {
        const manifest = decodeManifestV1(projection.manifest);
        if (!this.manifestValid(scopeKey, manifest)) {
          return {
            sections: [],
            status: "unavailable",
            omissions: [
              {
                reason: "that topic page is no longer valid",
                scope: request.scope,
              },
            ],
          };
        }
      }
    }
    const budget = Math.min(
      request.budget ?? MEMORY_MAX_BROWSE_PAGE_V1,
      MEMORY_MAX_BROWSE_PAGE_V1,
    );
    const after = decodeBrowseCursorV1(request.cursor);
    const topic = request.topic
      ? memoryCanonicalKeyV1(request.topic)
      : undefined;
    const rows = this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item
         WHERE scope_key = ?
           AND status = 'active'
           ${topic ? "AND (subject_key = ? OR canonical_key = ? OR text LIKE ?)" : ""}
           ${after ? "AND (recorded_at > ? OR (recorded_at = ? AND id > ?))" : ""}
         ORDER BY recorded_at ASC, id ASC
         LIMIT ?`,
        ...(topic
          ? after
            ? [
                scopeKey,
                topic,
                topic,
                `%${request.topic}%`,
                after.recordedAt,
                after.recordedAt,
                after.id,
                budget,
              ]
            : [scopeKey, topic, topic, `%${request.topic}%`, budget]
          : after
            ? [scopeKey, after.recordedAt, after.recordedAt, after.id, budget]
            : [scopeKey, budget]),
      )
      .toArray();
    const items = rows.map((row) => this.recordOf(row));
    const groups = new Map<string, MemoryItemRecordV1[]>();
    for (const item of items) {
      const key = item.subjectKey ?? "_chronology";
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    const sections: MemoryBrowseSectionV1[] = [...groups.entries()]
      .slice(0, MEMORY_BROWSE_SECTIONS_V1)
      .map(([sectionId, sectionItems]) => {
        const manifest: MemoryLeafManifestV1[] = sectionItems
          .slice(0, MEMORY_MAX_LEAF_MANIFEST_V1)
          .map((item) => ({ itemId: item.id, generation: item.generation }));
        return {
          sectionId,
          generation: epoch,
          title: sectionId === "_chronology" ? "Recent" : sectionId,
          summary: sectionItems
            .slice(0, 3)
            .map((item) => item.text)
            .join(" "),
          items: sectionItems,
          manifest,
        };
      });
    for (const section of sections) {
      if (!this.manifestValid(scopeKey, section.manifest)) {
        return {
          sections: [],
          status: "unavailable",
          omissions: [
            {
              reason: `section "${section.sectionId}" is no longer valid`,
              scope: request.scope,
            },
          ],
        };
      }
    }
    const last = items[items.length - 1];
    const more = items.length === budget;
    return {
      sections,
      status: items.length === 0 ? "empty" : "complete",
      ...(more && last ? { cursor: `${last.recordedAt}|${last.id}` } : {}),
      omissions: [],
    };
  }

  preparedCore(
    request: MemoryPreparedCoreRequestV1,
  ): MemoryPreparedCoreResultV1 {
    const omissions: MemoryEngineOmissionV1[] = [];
    const blocks: MemoryPreparedCoreResultV1["blocks"] = [];
    const manifest: MemoryLeafManifestV1[] = [];
    this.open();
    for (const scope of request.scopes) {
      const owned = this.refuseOwned(scope);
      if (owned) {
        omissions.push({ reason: owned, scope });
        continue;
      }
      const reason = authorizeMemoryScopeV1(request.authority, scope);
      if (reason) {
        omissions.push({ reason, scope });
        continue;
      }
      const scopeKey = memoryScopeKeyV1(scope);
      const epoch = this.invalidationEpoch(scopeKey);
      const row = this.#sql
        .exec<{
          generation: number;
          policy_version: number;
          checked_invalidation_epoch: number;
          body: string;
          manifest: string;
        }>(
          `SELECT generation, policy_version, checked_invalidation_epoch, body, manifest
           FROM memory_projection
           WHERE scope_key = ? AND name = 'core'`,
          scopeKey,
        )
        .toArray()[0];
      if (!row) {
        omissions.push({
          reason: "prepared core is not available yet",
          scope,
        });
        continue;
      }
      const leaves = decodeManifestV1(row.manifest);
      if (
        Number(row.checked_invalidation_epoch) !== epoch &&
        !this.manifestValid(scopeKey, leaves)
      ) {
        omissions.push({
          reason: "prepared core is no longer valid",
          scope,
        });
        continue;
      }
      blocks.push({
        scope,
        text: row.body,
        manifest: leaves,
        generation: Number(row.generation),
        policyVersion: Number(row.policy_version),
      });
      manifest.push(...leaves);
    }
    return {
      blocks,
      manifest,
      omissions,
      status:
        blocks.length === 0
          ? omissions.some((entry) => entry.reason.includes("not the owner"))
            ? "refused"
            : "empty"
          : omissions.length > 0
            ? "partial"
            : "complete",
    };
  }

  private arm(at: number): void {
    if (!this.#storage.setAlarm) return;
    const current = this.#storage.getAlarm?.() ?? null;
    if (current === null || current > at) this.#storage.setAlarm(at);
  }

  /**
   * Alarm arming is after the SQL commit on purpose: KV/SQL are separate
   * transactions on Cloudflare. A throw here must not report the mutation as
   * failed; `nextWakeupAt` is already durable.
   */
  private armAfterCommit(): void {
    try {
      this.ensureWakeup();
    } catch {
      // The due index is the wakeup. The next owner access re-arms.
    }
  }

  private refuseOwned(scope: MemoryScopeRefV1): string | undefined {
    if (!this.#ownedKinds) return undefined;
    if (this.#ownedKinds.includes(scope.kind)) return undefined;
    return "that Memory scope is not owned here";
  }

  private step(name: string): void {
    this.#onStep?.(name);
  }

  private ensureScope(scopeKey: string): void {
    this.#sql.exec(
      `INSERT INTO memory_scope (scope_key, generation, invalidation_epoch)
       VALUES (?, 0, 0)
       ON CONFLICT (scope_key) DO NOTHING`,
      scopeKey,
    );
  }

  private bumpGeneration(scopeKey: string): void {
    this.#sql.exec(
      `UPDATE memory_scope SET generation = generation + 1 WHERE scope_key = ?`,
      scopeKey,
    );
  }

  private advanceInvalidation(scopeKey: string): void {
    this.#sql.exec(
      `UPDATE memory_scope
       SET invalidation_epoch = invalidation_epoch + 1
       WHERE scope_key = ?`,
      scopeKey,
    );
  }

  private scopeGeneration(scopeKey: string): number {
    const row = this.#sql
      .exec<{ generation: number }>(
        `SELECT generation FROM memory_scope WHERE scope_key = ?`,
        scopeKey,
      )
      .toArray()[0];
    return Number(row?.generation ?? 0);
  }

  private invalidationEpoch(scopeKey: string): number {
    const row = this.#sql
      .exec<{ invalidation_epoch: number }>(
        `SELECT invalidation_epoch FROM memory_scope WHERE scope_key = ?`,
        scopeKey,
      )
      .toArray()[0];
    return Number(row?.invalidation_epoch ?? 0);
  }

  private receipt(scopeKey: string, operationKey: string): string | undefined {
    return this.#sql
      .exec<{ result: string }>(
        `SELECT result FROM memory_receipt
         WHERE scope_key = ? AND operation_key = ?`,
        scopeKey,
        operationKey,
      )
      .toArray()[0]?.result;
  }

  private putReceipt(
    scopeKey: string,
    operationKey: string,
    result: MemoryWriteResultV1 | MemoryForgetResultV1,
  ): void {
    this.#sql.exec(
      `INSERT INTO memory_receipt (scope_key, operation_key, result)
       VALUES (?, ?, ?)`,
      scopeKey,
      operationKey,
      JSON.stringify(result),
    );
  }

  private item(scopeKey: string, id: string): ItemRow | undefined {
    return this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item WHERE scope_key = ? AND id = ?`,
        scopeKey,
        id,
      )
      .toArray()[0];
  }

  private activeByKey(
    scopeKey: string,
    canonicalKey: string,
  ): ItemRow | undefined {
    return this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item
         WHERE scope_key = ? AND canonical_key = ? AND status = 'active'
         ORDER BY recorded_at DESC, id DESC
         LIMIT 1`,
        scopeKey,
        canonicalKey,
      )
      .toArray()[0];
  }

  private upsertFts(scopeKey: string, id: string, text: string): void {
    this.#sql.exec(
      `DELETE FROM memory_item_fts WHERE scope_key = ? AND id = ?`,
      scopeKey,
      id,
    );
    this.#sql.exec(
      `INSERT INTO memory_item_fts (text, scope_key, id) VALUES (?, ?, ?)`,
      text,
      scopeKey,
      id,
    );
  }

  private writeSources(
    scopeKey: string,
    itemId: string,
    sources: readonly MemorySourceInputV1[],
  ): void {
    for (const source of sources) {
      this.#sql.exec(
        `INSERT INTO memory_source (
          scope_key, source_id, source_revision, kind, locator, safe_excerpt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key, source_id, source_revision) DO UPDATE SET
           kind = excluded.kind,
           locator = excluded.locator,
           safe_excerpt = excluded.safe_excerpt`,
        scopeKey,
        source.sourceId,
        source.sourceRevision,
        source.kind,
        JSON.stringify(source.locator),
        source.safeExcerpt ?? null,
      );
      this.#sql.exec(
        `INSERT INTO memory_evidence (
          scope_key, item_id, source_id, source_revision)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        scopeKey,
        itemId,
        source.sourceId,
        source.sourceRevision,
      );
    }
  }

  private writeObservationLeaves(
    scopeKey: string,
    derivedId: string,
    sources: readonly MemorySourceInputV1[],
  ): void {
    const leaves = [...new Set(sources.map((source) => source.sourceId))].slice(
      0,
      MEMORY_MAX_LEAF_MANIFEST_V1,
    );
    for (const leafItemId of leaves) {
      const leaf = this.item(scopeKey, leafItemId);
      this.#sql.exec(
        `INSERT INTO memory_derivation (
          scope_key, derived_id, leaf_item_id, leaf_generation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        scopeKey,
        derivedId,
        leafItemId,
        Number(leaf?.generation ?? 1),
      );
    }
  }

  private sourceLineage(scopeKey: string, itemId: string): string {
    const rows = this.#sql
      .exec<{ source_id: string; source_revision: string }>(
        `SELECT source_id, source_revision FROM memory_evidence
         WHERE scope_key = ? AND item_id = ?
         ORDER BY source_id ASC, source_revision ASC`,
        scopeKey,
        itemId,
      )
      .toArray();
    if (rows.length === 0) return `item:${itemId}`;
    return rows
      .map((row) => `${row.source_id}@${row.source_revision}`)
      .join("|");
  }

  private queueIndexIntent(
    scopeKey: string,
    itemId: string,
    operation: "upsert" | "delete",
    now: Date,
    generation = 1,
  ): void {
    const vectorId = `${scopeKey}:${itemId}:${generation}:${operation}`;
    this.#sql.exec(
      `INSERT INTO memory_index_intent (
        scope_key, item_id, item_generation, operation, vector_id, state,
        mutation_id, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)
       ON CONFLICT (scope_key, item_id, item_generation, operation)
       DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at`,
      scopeKey,
      itemId,
      generation,
      operation,
      vectorId,
      now.getTime() + MEMORY_JOB_WAKEUP_MS_V1,
    );
  }

  private queueJob(input: {
    kind: string;
    scopeKey: string;
    sourceRef: string;
    inputGeneration: number;
    now: Date;
  }): void {
    const id = `${input.kind}:${input.scopeKey}:${input.sourceRef}`;
    this.#sql.exec(
      `INSERT INTO memory_job (
        id, kind, scope_key, source_ref, input_generation, state, attempt,
        next_attempt_at, claim_token, effect_ref)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         state = 'pending',
         next_attempt_at = excluded.next_attempt_at,
         input_generation = excluded.input_generation`,
      id,
      input.kind,
      input.scopeKey,
      input.sourceRef,
      input.inputGeneration,
      input.now.getTime() + MEMORY_JOB_WAKEUP_MS_V1,
    );
  }

  private isSuppressed(scopeKey: string, exactKey: string): boolean {
    const row = this.#sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM memory_suppression
         WHERE scope_key = ? AND exact_key = ?`,
        scopeKey,
        exactKey,
      )
      .toArray()[0];
    return Number(row?.n ?? 0) > 0;
  }

  private manifestValid(
    scopeKey: string,
    manifest: MemoryLeafManifestV1[],
  ): boolean {
    if (manifest.length > MEMORY_MAX_LEAF_MANIFEST_V1) return false;
    for (const leaf of manifest) {
      const item = this.item(scopeKey, leaf.itemId);
      if (!item || item.status !== "active") return false;
      if (Number(item.generation) !== leaf.generation) return false;
    }
    return true;
  }

  private hitOf(row: ItemRow, score: number): MemoryHitV1 {
    const item = this.recordOf(row);
    const sourceRefs = this.#sql
      .exec<{ source_id: string; source_revision: string }>(
        `SELECT source_id, source_revision FROM memory_evidence
         WHERE scope_key = ? AND item_id = ?`,
        row.scope_key,
        row.id,
      )
      .toArray()
      .map((entry) => ({
        sourceId: entry.source_id,
        sourceRevision: entry.source_revision,
      }));
    return { item, score, sourceRefs };
  }

  private recordOf(row: ItemRow): MemoryItemRecordV1 {
    return {
      id: row.id,
      generation: Number(row.generation),
      kind: row.kind as MemoryItemKindV1,
      status: row.status as MemoryItemStatusV1,
      canonicalKey: row.canonical_key,
      text: row.text,
      ...(row.subject_key ? { subjectKey: row.subject_key } : {}),
      ...(row.predicate_key ? { predicateKey: row.predicate_key } : {}),
      ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
      recordedAt: row.recorded_at,
      ...(row.valid_from ? { validFrom: row.valid_from } : {}),
      ...(row.valid_to ? { validTo: row.valid_to } : {}),
      createdBy: row.created_by,
      ...(row.confidence === null
        ? {}
        : { confidence: Number(row.confidence) }),
      scope: decodeMemoryScopeKeyV1(row.scope_key),
    };
  }
}

function itemIdForOperationV1(operationKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < operationKey.length; index += 1) {
    hash ^= operationKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const low = (hash >>> 0).toString(16).padStart(8, "0");
  let hash2 = 5381;
  for (let index = 0; index < operationKey.length; index += 1) {
    hash2 = (hash2 * 33) ^ operationKey.charCodeAt(index);
  }
  const high = (hash2 >>> 0).toString(16).padStart(8, "0");
  return `it_${high}${low}`;
}

function decodeManifestV1(raw: string): MemoryLeafManifestV1[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.itemId !== "string" ||
        typeof record.generation !== "number"
      ) {
        return [];
      }
      return [{ itemId: record.itemId, generation: record.generation }];
    });
  } catch {
    return [];
  }
}

function decodeBrowseCursorV1(
  cursor: string | undefined,
): { recordedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  const split = cursor.indexOf("|");
  if (split <= 0) return undefined;
  return { recordedAt: cursor.slice(0, split), id: cursor.slice(split + 1) };
}

function decodeEvidenceV1(
  itemId: string,
  row: {
    source_id: string;
    source_revision: string;
    kind: string;
    locator: string;
    safe_excerpt: string | null;
  },
): MemoryEvidenceV1 {
  let locator: MemorySourceLocatorV1 = {
    kind: "explicit",
    revision: row.source_revision,
  };
  try {
    locator = JSON.parse(row.locator) as MemorySourceLocatorV1;
  } catch {
    // Keep the explicit fallback: a corrupt locator must not invent a quote.
  }
  return {
    itemId,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    kind: row.kind as MemorySourceKindV1,
    locator,
    ...(row.safe_excerpt ? { excerpt: row.safe_excerpt } : {}),
  };
}
