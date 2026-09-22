// Canonical Memory operations over owner-local SQLite.
//
// Mutations, receipts, FTS and pending jobs commit in one transactionSync.
// External embeddings, model calls and other Durable Object RPCs stay out.
// The owner's existing alarm is armed after that commit with the due time
// already on the job row, so a crash between them still has a durable
// wakeup: the next owner access reads the due index and re-arms.

import {
  fuseMemoryRecallV1,
  memoryRecallCacheKeyV1,
  memoryTextOverlapsV1,
  selectHydrationIdsV1,
  type FusionMemoryItemV1,
  type MemoryChannelCandidatesV1,
  type MemoryNeighborV1,
} from "./hybrid.js";
import {
  MEMORY_POLICY_V1,
  clipMemoryQueryV1,
  suballocateMemoryScopesV1,
} from "./policy.js";
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
  isMemoryProfileSubjectV1,
  memoryCanonicalKeyV1,
  memoryItemVectorIdV1,
  memoryJobBackoffMsV1,
  memoryScopeKeyV1,
  memoryTokenEstimateV1,
  MEMORY_BROWSE_SECTIONS_V1,
  MEMORY_CORE_POLICY_VERSION_V1,
  MEMORY_CORE_TOKEN_BUDGET_V1,
  MEMORY_DRAIN_LOCAL_LIMIT_V1,
  MEMORY_EMBEDDING_POLICY_ID_V1,
  MEMORY_JOB_CONTINUATION_MS_V1,
  MEMORY_JOB_WAKEUP_MS_V1,
  MEMORY_MAX_BROWSE_PAGE_V1,
  MEMORY_MAX_CAPTURE_CHARS_V1,
  MEMORY_MAX_EXPAND_REFS_V1,
  MEMORY_MAX_JOB_ATTEMPTS_V1,
  MEMORY_MAX_LEAF_MANIFEST_V1,
  MEMORY_MAX_SOURCE_EXCERPT_V1,
  MEMORY_MAX_SOURCES_V1,
  MEMORY_MAX_TEXT_CHARS_V1,
  MEMORY_PENDING_INDEX_PAGE_V1,
  MEMORY_RECALL_PAGE_V1,
  MEMORY_TOPIC_POLICY_VERSION_V1,
  type MemoryAbandonObligationRequestV1,
  type MemoryAbandonResultV1,
  type MemoryAdmitOutboxRequestV1,
  type MemoryAdmitOutboxResultV1,
  type MemoryAuthorityV1,
  type MemoryBrowseRequestV1,
  type MemoryBrowseResultV1,
  type MemoryBrowseSectionV1,
  type MemoryCaptureExtractionRequestV1,
  type MemoryCaptureResultV1,
  type MemoryCompletenessV1,
  type MemoryConsolidatedObservationV1,
  type MemoryEngineScopeKindV1,
  type MemoryEvidenceV1,
  type MemoryExpandRequestV1,
  type MemoryExpandResultV1,
  type MemoryExtractedProposalV1,
  type MemoryForgetReceiptV1,
  type MemoryForgetRequestV1,
  type MemoryForgetResultV1,
  type MemoryHitV1,
  type MemoryItemKindV1,
  type MemoryItemRecordV1,
  type MemoryItemStatusV1,
  type MemoryJobKindV1,
  type MemoryJobPrincipalV1,
  type MemoryJobStateV1,
  type MemoryLeafManifestV1,
  type MemoryEngineOmissionV1,
  type MemoryOperationsV1,
  type MemoryOutboxPayloadV1,
  type MemoryPreparedCoreRequestV1,
  type MemoryPreparedCoreResultV1,
  type MemoryRecallChannelStatusV1,
  type MemoryRecallRequestV1,
  type MemoryRecallResultV1,
  type MemoryRelationV1,
  type MemorySemanticRankV1,
  type MemoryScopeRefV1,
  type MemorySemanticCoverageV1,
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

type JobRow = {
  id: string;
  kind: string;
  scope_key: string;
  source_ref: string | null;
  input_generation: number;
  state: string;
  attempt: number;
  next_attempt_at: number;
  claim_token: string | null;
  effect_ref: string | null;
  principal: string | null;
};

type IndexIntentRow = {
  scope_key: string;
  item_id: string;
  item_generation: number;
  operation: string;
  vector_id: string;
  state: string;
  mutation_id: string | null;
  claim_token: string | null;
  next_attempt_at: number;
};

type RetentionRow = {
  scope_key: string;
  source_id: string;
  source_revision: string;
  kind: string;
  locator: string;
  captured_text: string;
  captured_at: string;
  obligation_id: string;
  state: string;
};

export interface MemoryClaimedJobV1 {
  id: string;
  kind: MemoryJobKindV1;
  scopeKey: string;
  scope: MemoryScopeRefV1;
  sourceRef?: string;
  inputGeneration: number;
  attempt: number;
  claimToken: string;
  effectRef?: string;
  principal?: MemoryJobPrincipalV1;
  authority: MemoryAuthorityV1;
}

export interface MemoryClaimedIndexIntentV1 {
  scopeKey: string;
  itemId: string;
  itemGeneration: number;
  operation: "upsert" | "delete";
  vectorId: string;
  claimToken: string;
  text?: string;
}

export type MemoryClaimedBatchV1 =
  | { kind: "local"; jobs: MemoryClaimedJobV1[] }
  | { kind: "external"; jobs: MemoryClaimedJobV1[] }
  | { kind: "index"; intent: MemoryClaimedIndexIntentV1 }
  | { kind: "idle"; jobs: [] };

export interface MemoryJobInspectV1 {
  id: string;
  kind: MemoryJobKindV1;
  scopeKey: string;
  sourceRef?: string;
  inputGeneration: number;
  state: MemoryJobStateV1;
  attempt: number;
  nextAttemptAt: number;
  claimToken?: string;
  effectRef?: string;
  principal?: MemoryJobPrincipalV1;
}

export interface MemoryIndexIntentInspectV1 {
  scopeKey: string;
  itemId: string;
  itemGeneration: number;
  operation: "upsert" | "delete";
  vectorId: string;
  state: string;
  mutationId?: string;
  claimToken?: string;
  nextAttemptAt: number;
}

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
  #recallCache = new Map<string, MemoryRecallResultV1>();

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
         WHERE state IN ('pending', 'claimed')
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
    this.open();
    try {
      const result = this.#storage.transactionSync(() => {
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
        const origin = request.origin ?? "explicit";
        if (suppressedOverride && origin !== "explicit") {
          return {
            status: "refused",
            reason:
              "forgotten evidence cannot be reintroduced by extraction or consolidation",
          } satisfies MemoryWriteResultV1;
        }
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
           VALUES (?, ?, 1, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
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
          request.confidence ?? null,
        );
        this.upsertFts(scopeKey, itemId, text);
        this.step("fts");
        this.writeSources(scopeKey, itemId, sources);
        this.step("sources");
        if (kind === "observation") {
          this.writeObservationLeaves(
            scopeKey,
            itemId,
            request.leafItems ??
              sources.map((source) => ({ itemId: source.sourceId })),
          );
        }
        if (request.relations) {
          this.writeRelations(scopeKey, itemId, request.relations);
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
        this.queueJob({
          id: `core-rebuild:${scopeKey}`,
          kind: "core-rebuild",
          scopeKey,
          sourceRef: itemId,
          inputGeneration: this.scopeGeneration(scopeKey),
          now,
        });
        if (request.subjectKey) {
          this.queueJob({
            id: `topic-rebuild:${scopeKey}:${request.subjectKey}`,
            kind: "topic-rebuild",
            scopeKey,
            sourceRef: request.subjectKey,
            inputGeneration: this.scopeGeneration(scopeKey),
            now,
          });
        }
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
    this.open();
    try {
      const result = this.#storage.transactionSync(() => {
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
          id: `view-repair:${scopeKey}`,
          kind: "view-repair",
          scopeKey,
          sourceRef: target.id,
          inputGeneration: this.scopeGeneration(scopeKey),
          now,
        });
        this.queueJob({
          id: `core-rebuild:${scopeKey}`,
          kind: "core-rebuild",
          scopeKey,
          sourceRef: target.id,
          inputGeneration: this.scopeGeneration(scopeKey),
          now,
        });
        if (target.subject_key) {
          this.queueJob({
            id: `topic-rebuild:${scopeKey}:${target.subject_key}`,
            kind: "topic-rebuild",
            scopeKey,
            sourceRef: target.subject_key,
            inputGeneration: this.scopeGeneration(scopeKey),
            now,
          });
        }
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
    const clipped = clipMemoryQueryV1(request.query);
    if (clipped.clipped) {
      omissions.push({
        reason: `the query was clipped to ${MEMORY_POLICY_V1.maxQueryBytes} bytes`,
      });
    }
    const query = clipped.query;
    if (!query) {
      return {
        hits: [],
        status: "empty",
        omissions,
        membershipRevision: request.authority.membershipRevision,
      };
    }
    const focusKey = request.focusScope
      ? memoryScopeKeyV1(request.focusScope)
      : undefined;
    const page = suballocateMemoryScopesV1(authorized, {
      limit: MEMORY_POLICY_V1.maxScopesPerRequest,
      key: (scope) => memoryScopeKeyV1(scope),
      ...(focusKey ? { explicitKey: focusKey } : {}),
    });
    for (const scope of page.omitted) {
      omissions.push({
        reason:
          "this scope was outside the recall page; name it to search it directly",
        scope,
      });
    }
    const epochs = page.selected.map((scope) => {
      const scopeKey = memoryScopeKeyV1(scope);
      return `${scopeKey}:${this.scopeGeneration(scopeKey)}:${this.invalidationEpoch(scopeKey)}`;
    });
    const cacheKey = memoryRecallCacheKeyV1({
      query,
      scopeKeys: page.selected.map((scope) => memoryScopeKeyV1(scope)),
      membershipRevision: request.authority.membershipRevision,
      epochs,
      embeddingPolicy: MEMORY_EMBEDDING_POLICY_ID_V1,
      filters: JSON.stringify({
        filters: request.filters ?? {},
        semantic: (request.semanticRanks ?? []).map(
          (rank) => `${rank.scopeKey}:${rank.itemId}:${rank.rank}`,
        ),
        semanticStatus: request.semanticStatus ?? "",
      }),
    });
    const cached = this.#recallCache.get(cacheKey);
    if (
      cached &&
      cached.hits.every((hit) =>
        this.itemStillActive(hit.item.scope, hit.item.id, hit.item.generation),
      )
    ) {
      return cached;
    }
    const budget = Math.min(
      request.budget ?? MEMORY_RECALL_PAGE_V1,
      MEMORY_POLICY_V1.candidatesPerChannel,
    );
    const channels = this.recallChannels(page.selected, query, request, budget);
    for (const omission of channels.omissions) omissions.push(omission);
    const hydratedIds = selectHydrationIdsV1(
      channels.channels,
      MEMORY_POLICY_V1.hydratedCandidates,
    );
    const items = new Map<string, FusionMemoryItemV1>();
    for (const hit of hydratedIds) {
      const row = this.item(hit.scopeKey, hit.itemId);
      if (!row || row.status !== "active") continue;
      if (this.isSuppressed(hit.scopeKey, row.canonical_key)) continue;
      const record = this.recordOf(row);
      if (request.filters?.kind && record.kind !== request.filters.kind) {
        continue;
      }
      if (
        request.filters?.subjectKey &&
        record.subjectKey !== request.filters.subjectKey
      ) {
        continue;
      }
      items.set(`${hit.scopeKey}\u0000${hit.itemId}`, this.fusionItem(row));
    }
    const seedIds = new Set([...items.values()].map((item) => item.itemId));
    const neighbors = this.recallNeighbors(page.selected, seedIds);
    const fused = fuseMemoryRecallV1({
      channels: channels.channels,
      items,
      neighbors,
      hydrateNeighbor: (scopeKey, itemId) => {
        const row = this.item(scopeKey, itemId);
        if (!row || row.status !== "active") return undefined;
        if (this.isSuppressed(scopeKey, row.canonical_key)) return undefined;
        return this.fusionItem(row);
      },
      tokenBudget: Math.min(
        request.tokenBudget ?? MEMORY_POLICY_V1.activeRecallTokens,
        MEMORY_POLICY_V1.activeRecallTokens,
      ),
    });
    const hits = fused.items.slice(0, budget).flatMap((item, index) => {
      const row = this.item(item.scopeKey, item.itemId);
      return row ? [this.hitOf(row, fused.items.length - index)] : [];
    });
    let coverage: MemorySemanticCoverageV1 = "none";
    try {
      coverage = this.semanticCoverageFor(
        page.selected.map((scope) => memoryScopeKeyV1(scope)),
      );
    } catch {
      coverage = "none";
    }
    if (coverage === "partial") {
      omissions.push({
        reason:
          "semantic index coverage is partial; exact and lexical recall already see committed items",
      });
    } else if (coverage === "unconfirmed") {
      omissions.push({
        reason:
          "Vectorize mutations are unconfirmed; exact and lexical recall already see committed items",
      });
    }
    if (fused.omitted > 0) {
      omissions.push({
        reason: `${fused.omitted} memory item(s) were outside the token budget`,
      });
    }
    const ftsFailed = channels.channels.some(
      (channel) =>
        channel.channel === "fts" && channel.status === "unavailable",
    );
    const semanticStatus = channels.channels.find(
      (channel) => channel.channel === "semantic",
    )?.status;
    const status: MemoryCompletenessV1 = ftsFailed
      ? hits.length === 0
        ? "unavailable"
        : "partial"
      : hits.length === 0
        ? "empty"
        : page.omitted.length > 0 ||
            fused.omitted > 0 ||
            coverage === "partial" ||
            semanticStatus === "partial" ||
            semanticStatus === "unavailable"
          ? "partial"
          : "complete";
    const result: MemoryRecallResultV1 = {
      hits,
      status,
      ...(fused.items.length > budget
        ? { cursor: hits[hits.length - 1]?.item.id }
        : page.omitted.length > 0
          ? { cursor: memoryScopeKeyV1(page.omitted[0]!) }
          : {}),
      omissions,
      membershipRevision: request.authority.membershipRevision,
      semanticCoverage: coverage,
      channels: {
        fts: channels.channels.find((channel) => channel.channel === "fts")!
          .status,
        semantic: semanticStatus ?? "skipped",
        time: channels.channels.find((channel) => channel.channel === "time")!
          .status,
      },
      tokensEstimated: fused.tokensEstimated,
    };
    if (this.#recallCache.size > 32) {
      const oldest = this.#recallCache.keys().next().value;
      if (oldest) this.#recallCache.delete(oldest);
    }
    this.#recallCache.set(cacheKey, result);
    return result;
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
    if (request.topic) {
      const stored = this.readTopicProjection(scopeKey, request.topic, epoch);
      if (stored) return stored;
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

  /**
   * Rebuilds a scope's core when the projection is missing or older than the
   * latest write. The background job waits out its wakeup so a write itself
   * stays cheap; the next Turn's prompt cannot.
   */
  refreshPreparedCores(request: MemoryPreparedCoreRequestV1): void {
    this.open();
    for (const scope of request.scopes) {
      if (this.refuseOwned(scope)) continue;
      if (authorizeMemoryScopeV1(request.authority, scope)) continue;
      const scopeKey = memoryScopeKeyV1(scope);
      const epoch = this.invalidationEpoch(scopeKey);
      const row = this.#sql
        .exec<{ checked_invalidation_epoch: number; manifest: string }>(
          `SELECT checked_invalidation_epoch, manifest FROM memory_projection
           WHERE scope_key = ? AND name = 'core'`,
          scopeKey,
        )
        .toArray()[0];
      const covers =
        row !== undefined &&
        Number(row.checked_invalidation_epoch) === epoch &&
        this.coreMatchesSelection(scopeKey, decodeManifestV1(row.manifest));
      if (covers) continue;
      this.rebuildCore(scopeKey);
      this.#sql.exec(
        `UPDATE memory_job SET state = 'done', claim_token = NULL
         WHERE id = ? AND state != 'done'`,
        `core-rebuild:${scopeKey}`,
      );
    }
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

  captureExtraction(
    request: MemoryCaptureExtractionRequestV1,
  ): MemoryCaptureResultV1 {
    const destination = request.destinationScope ?? request.scope;
    const owned = this.refuseOwned(request.scope);
    if (owned) return { status: "refused", reason: owned };
    const authorized = authorizeMemoryScopeV1(request.authority, request.scope);
    if (authorized) return { status: "refused", reason: authorized };
    const destOwned = this.refuseOwned(destination);
    const destAuthorized = authorizeMemoryScopeV1(
      request.authority,
      destination,
    );
    if (destAuthorized) return { status: "refused", reason: destAuthorized };
    const captured = request.source.capturedText.trim();
    if (!captured || captured.length > MEMORY_MAX_CAPTURE_CHARS_V1) {
      return {
        status: "refused",
        reason: `captured source must be between 1 and ${MEMORY_MAX_CAPTURE_CHARS_V1} characters`,
      };
    }
    const secret = refuseMemorySecretV1(captured);
    if (secret) return { status: "refused", reason: secret.reason };
    if (request.source.safeExcerpt) {
      const excerptSecret = refuseMemorySecretV1(request.source.safeExcerpt);
      if (excerptSecret) {
        return { status: "refused", reason: excerptSecret.reason };
      }
    }
    const destinationKey = memoryScopeKeyV1(destination);
    const sourceKey = memoryScopeKeyV1(request.scope);
    const now = this.#now();
    const obligationId = extractionObligationIdV1(
      destinationKey,
      request.source.sourceId,
      request.source.sourceRevision,
    );
    try {
      const result = this.#storage.transactionSync(() => {
        this.open();
        if (!destOwned) {
          return this.captureLocalExtraction({
            scopeKey: destinationKey,
            obligationId,
            request,
            captured,
            now,
          });
        }
        const existing = this.#sql
          .exec<{ state: string }>(
            `SELECT state FROM memory_outbox WHERE id = ?`,
            obligationId,
          )
          .toArray()[0];
        if (existing) {
          return {
            status: "ok",
            obligationId,
            duplicate: true,
            queued: "outbox",
          } satisfies MemoryCaptureResultV1;
        }
        this.ensureScope(sourceKey);
        this.retainSource({
          scopeKey: sourceKey,
          obligationId,
          source: request.source,
          captured,
          now,
        });
        const payload: MemoryOutboxPayloadV1 = {
          destinationScope: destination,
          principal: request.principal,
          authority: request.authority,
          source: { ...request.source, capturedText: captured },
        };
        this.#sql.exec(
          `INSERT INTO memory_outbox (
            id, destination_scope_key, payload, state, created_at, acked_at)
           VALUES (?, ?, ?, 'pending', ?, NULL)`,
          obligationId,
          destinationKey,
          JSON.stringify(payload),
          now.toISOString(),
        );
        this.queueJob({
          id: `outbox-deliver:${obligationId}`,
          kind: "outbox-deliver",
          scopeKey: sourceKey,
          sourceRef: obligationId,
          inputGeneration: this.scopeGeneration(sourceKey),
          now,
          principal: request.principal,
        });
        return {
          status: "ok",
          obligationId,
          duplicate: false,
          queued: "outbox",
        } satisfies MemoryCaptureResultV1;
      });
      this.armAfterCommit();
      return result;
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error ? error.message : "Memory capture failed",
      };
    }
  }

  admitOutbox(request: MemoryAdmitOutboxRequestV1): MemoryAdmitOutboxResultV1 {
    const owned = this.refuseOwned(request.payload.destinationScope);
    if (owned) return { status: "refused", reason: owned };
    const authorized = authorizeMemoryScopeV1(
      request.payload.authority,
      request.payload.destinationScope,
    );
    if (authorized) return { status: "refused", reason: authorized };
    const now = this.#now();
    try {
      const result = this.#storage.transactionSync(() => {
        this.open();
        const captured = this.captureLocalExtraction({
          scopeKey: memoryScopeKeyV1(request.payload.destinationScope),
          obligationId: request.outboxId,
          request: {
            authority: request.payload.authority,
            scope: request.payload.destinationScope,
            principal: request.payload.principal,
            source: request.payload.source,
          },
          captured: request.payload.source.capturedText,
          now,
        });
        if (captured.status !== "ok") {
          return {
            status: captured.status,
            reason: captured.reason,
          } satisfies MemoryAdmitOutboxResultV1;
        }
        return {
          status: "ok",
          obligationId: captured.obligationId,
          duplicate: captured.duplicate,
        } satisfies MemoryAdmitOutboxResultV1;
      });
      this.armAfterCommit();
      return result;
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error ? error.message : "Memory outbox admit failed",
      };
    }
  }

  acknowledgeOutbox(outboxId: string): boolean {
    this.open();
    const now = this.#now();
    const result = this.#storage.transactionSync(() => {
      const row = this.#sql
        .exec<{ state: string; payload: string }>(
          `SELECT state, payload FROM memory_outbox WHERE id = ?`,
          outboxId,
        )
        .toArray()[0];
      if (!row) return false;
      this.#sql.exec(
        `UPDATE memory_outbox SET state = 'acked', acked_at = ? WHERE id = ?`,
        now.toISOString(),
        outboxId,
      );
      this.#sql.exec(
        `UPDATE memory_job SET state = 'done', claim_token = NULL
         WHERE id = ?`,
        `outbox-deliver:${outboxId}`,
      );
      this.releaseRetention(outboxId);
      return true;
    });
    this.armAfterCommit();
    return result;
  }

  abandonObligation(
    request: MemoryAbandonObligationRequestV1,
  ): MemoryAbandonResultV1 {
    const reason = authorizeMemoryScopeV1(request.authority, {
      kind: "user",
      userId: request.authority.userId,
    });
    if (reason && request.authority.actor !== "user") {
      return {
        status: "refused",
        reason: "only the authenticated User can abandon a Memory obligation",
      };
    }
    this.open();
    const result = this.#storage.transactionSync(() => {
      const job = this.job(request.obligationId);
      if (!job) return { status: "ok", abandoned: false } as const;
      this.#sql.exec(
        `UPDATE memory_job SET state = 'failed', claim_token = NULL WHERE id = ?`,
        request.obligationId,
      );
      this.#sql.exec(
        `UPDATE memory_source_retention SET state = 'released'
         WHERE obligation_id = ?`,
        request.obligationId,
      );
      this.#sql.exec(
        `UPDATE memory_outbox SET state = 'acked', acked_at = ?
         WHERE id = ?`,
        this.#now().toISOString(),
        request.obligationId,
      );
      return { status: "ok", abandoned: true } as const;
    });
    this.armAfterCommit();
    return result;
  }

  claimDueWork(now = this.#now()): MemoryClaimedBatchV1 {
    this.open();
    return this.#storage.transactionSync(() => {
      const local = this.dueJobs(
        ["view-repair", "core-rebuild", "topic-rebuild"],
        now,
        MEMORY_DRAIN_LOCAL_LIMIT_V1,
      );
      if (local.length > 0) {
        return {
          kind: "local",
          jobs: local.map((job) => this.claimJobRow(job, now, "local")),
        };
      }
      const external = this.dueJobs(
        ["extract", "consolidate", "outbox-deliver"],
        now,
        1,
      );
      if (external[0]) {
        return {
          kind: "external",
          jobs: [this.claimJobRow(external[0], now, "external")],
        };
      }
      const intent = this.dueIndexIntent(now);
      if (intent) {
        return { kind: "index", intent: this.claimIndexIntent(intent, now) };
      }
      return { kind: "idle", jobs: [] };
    });
  }

  completeClaimedJob(
    claim: MemoryClaimedJobV1,
    state: Extract<MemoryJobStateV1, "done" | "blocked" | "failed">,
    options: { releaseRetention?: boolean; reason?: string } = {},
  ): boolean {
    this.open();
    const now = this.#now();
    const ok = this.#storage.transactionSync(() => {
      const row = this.job(claim.id);
      if (!row || row.claim_token !== claim.claimToken) return false;
      this.#sql.exec(
        `UPDATE memory_job
         SET state = ?, claim_token = NULL, next_attempt_at = ?
         WHERE id = ?`,
        state,
        now.getTime(),
        claim.id,
      );
      if (options.reason) {
        this.#sql.exec(
          `INSERT INTO memory_job_result (job_id, body)
           VALUES (?, ?)
           ON CONFLICT (job_id) DO UPDATE SET body = excluded.body`,
          claim.id,
          JSON.stringify({ reason: options.reason, state }),
        );
      }
      if (options.releaseRetention && claim.sourceRef) {
        this.releaseRetention(claim.sourceRef);
      }
      return true;
    });
    this.armAfterCommit();
    return ok;
  }

  retryClaimedJob(claim: MemoryClaimedJobV1, terminal: boolean): boolean {
    this.open();
    const now = this.#now();
    const ok = this.#storage.transactionSync(() => {
      const row = this.job(claim.id);
      if (!row || row.claim_token !== claim.claimToken) return false;
      if (terminal || Number(row.attempt) >= MEMORY_MAX_JOB_ATTEMPTS_V1) {
        this.#sql.exec(
          `UPDATE memory_job SET state = 'failed', claim_token = NULL
           WHERE id = ?`,
          claim.id,
        );
        return true;
      }
      this.#sql.exec(
        `UPDATE memory_job
         SET state = 'pending', claim_token = NULL, next_attempt_at = ?
         WHERE id = ?`,
        now.getTime() + memoryJobBackoffMsV1(Number(row.attempt)),
        claim.id,
      );
      return true;
    });
    this.armAfterCommit();
    return ok;
  }

  markJobDispatched(claim: MemoryClaimedJobV1, effectRef: string): boolean {
    this.open();
    return this.#storage.transactionSync(() => {
      const row = this.job(claim.id);
      if (!row || row.claim_token !== claim.claimToken) return false;
      if (row.effect_ref) return false;
      this.#sql.exec(
        `UPDATE memory_job SET effect_ref = ? WHERE id = ?`,
        effectRef,
        claim.id,
      );
      return true;
    });
  }

  storeJobResult(claim: MemoryClaimedJobV1, body: unknown): boolean {
    this.open();
    return this.#storage.transactionSync(() => {
      const row = this.job(claim.id);
      if (!row || row.claim_token !== claim.claimToken) return false;
      this.#sql.exec(
        `INSERT INTO memory_job_result (job_id, body)
         VALUES (?, ?)
         ON CONFLICT (job_id) DO UPDATE SET body = excluded.body`,
        claim.id,
        JSON.stringify(body),
      );
      this.#sql.exec(
        `UPDATE memory_job SET effect_ref = ? WHERE id = ?`,
        `result:${claim.id}`,
        claim.id,
      );
      return true;
    });
  }

  jobResult<T>(jobId: string): T | undefined {
    this.open();
    const row = this.#sql
      .exec<{ body: string }>(
        `SELECT body FROM memory_job_result WHERE job_id = ?`,
        jobId,
      )
      .toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.body) as T;
    } catch {
      return undefined;
    }
  }

  applyExtractedProposals(
    claim: MemoryClaimedJobV1,
    proposals: readonly MemoryExtractedProposalV1[],
  ): { written: number; skipped: number } {
    const source = this.retainedSource(claim.sourceRef ?? claim.id);
    let written = 0;
    let skipped = 0;
    for (const proposal of proposals) {
      const outcome = this.write({
        authority: claim.authority,
        scope: claim.scope,
        content: proposal.text,
        operationKey: `extract:${claim.id}:${memoryCanonicalKeyV1(proposal.text)}`,
        kind: proposal.kind,
        origin: "extraction",
        createdBy: createdByPrincipalV1(claim.authority),
        ...(proposal.subjectKey ? { subjectKey: proposal.subjectKey } : {}),
        ...(proposal.occurredAt ? { occurredAt: proposal.occurredAt } : {}),
        ...(proposal.confidence !== undefined
          ? { confidence: proposal.confidence }
          : {}),
        ...(source
          ? {
              sources: [
                {
                  sourceId: source.source_id,
                  sourceRevision: source.source_revision,
                  kind: source.kind as MemorySourceKindV1,
                  locator: decodeLocatorV1(
                    source.locator,
                    source.source_revision,
                  ),
                  ...(source.captured_text
                    ? {
                        safeExcerpt: source.captured_text.slice(
                          0,
                          MEMORY_MAX_SOURCE_EXCERPT_V1,
                        ),
                      }
                    : {}),
                },
              ],
            }
          : {}),
      });
      if (outcome.status === "ok" && !outcome.receipt.duplicate) written += 1;
      else skipped += 1;
    }
    const subjects = [
      ...new Set(
        proposals.flatMap((proposal) =>
          proposal.subjectKey ? [proposal.subjectKey] : [],
        ),
      ),
    ];
    const now = this.#now();
    this.#storage.transactionSync(() => {
      const row = this.job(claim.id);
      if (!row || row.claim_token !== claim.claimToken) return;
      for (const subjectKey of subjects) {
        this.queueJob({
          id: `consolidate:${claim.scopeKey}:${subjectKey}`,
          kind: "consolidate",
          scopeKey: claim.scopeKey,
          sourceRef: subjectKey,
          inputGeneration: this.scopeGeneration(claim.scopeKey),
          now,
          principal: claim.principal,
        });
      }
    });
    this.armAfterCommit();
    return { written, skipped };
  }

  applyConsolidatedObservation(
    claim: MemoryClaimedJobV1,
    observation: MemoryConsolidatedObservationV1,
  ): MemoryWriteResultV1 {
    const leaves = observation.leafItemIds
      .map((itemId) => this.item(claim.scopeKey, itemId))
      .filter((row): row is ItemRow => Boolean(row));
    if (leaves.some((leaf) => leaf.status !== "active")) {
      return {
        status: "refused",
        reason: "consolidation leaves are no longer active",
      };
    }
    if (leaves.length > MEMORY_MAX_LEAF_MANIFEST_V1) {
      return {
        status: "refused",
        reason: `an observation may depend on at most ${MEMORY_MAX_LEAF_MANIFEST_V1} leaves; split it`,
      };
    }
    return this.write({
      authority: claim.authority,
      scope: claim.scope,
      content: observation.text,
      operationKey: `consolidate:${claim.id}:${memoryCanonicalKeyV1(observation.text)}`,
      kind: "observation",
      origin: "consolidation",
      subjectKey: observation.subjectKey,
      createdBy: createdByPrincipalV1(claim.authority),
      ...(observation.confidence !== undefined
        ? { confidence: observation.confidence }
        : {}),
      leafItems: observation.leafItemIds.map((itemId) => ({ itemId })),
      relations: observation.relations,
    });
  }

  runLocalJob(claim: MemoryClaimedJobV1): boolean {
    if (claim.kind === "core-rebuild") {
      this.rebuildCore(claim.scopeKey);
      return this.completeClaimedJob(claim, "done");
    }
    if (claim.kind === "topic-rebuild") {
      this.rebuildTopic(claim.scopeKey, claim.sourceRef);
      return this.completeClaimedJob(claim, "done");
    }
    if (claim.kind === "view-repair") {
      this.rebuildCore(claim.scopeKey);
      this.rebuildAllTopics(claim.scopeKey);
      return this.completeClaimedJob(claim, "done");
    }
    return false;
  }

  rebuildCore(scopeKey: string): void {
    this.open();
    const now = this.#now();
    this.#storage.transactionSync(() => {
      const epoch = this.invalidationEpoch(scopeKey);
      const selected = this.selectCoreItems(scopeKey);
      const manifest = selected.map((item) => ({
        itemId: item.id,
        generation: Number(item.generation),
      }));
      const body = selected.map((item) => item.text).join("\n");
      this.putProjection({
        scopeKey,
        name: "core",
        policyVersion: MEMORY_CORE_POLICY_VERSION_V1,
        epoch,
        body,
        manifest,
        now,
      });
    });
  }

  rebuildTopic(scopeKey: string, subjectKey?: string): void {
    this.open();
    const now = this.#now();
    this.#storage.transactionSync(() => {
      const subjects = subjectKey
        ? [subjectKey]
        : this.#sql
            .exec<{ subject_key: string }>(
              `SELECT DISTINCT subject_key FROM memory_item
               WHERE scope_key = ? AND status = 'active' AND subject_key IS NOT NULL
               ORDER BY subject_key ASC`,
              scopeKey,
            )
            .toArray()
            .map((row) => row.subject_key);
      for (const subject of subjects) {
        this.writeTopicProjection(scopeKey, subject, now);
      }
    });
  }

  rebuildAllTopics(scopeKey: string): void {
    this.rebuildTopic(scopeKey);
  }

  completeIndexIntent(
    claim: MemoryClaimedIndexIntentV1,
    mutationId: string | undefined,
    state: "unconfirmed" | "failed",
  ): boolean {
    this.open();
    const now = this.#now();
    const ok = this.#storage.transactionSync(() => {
      const row = this.indexIntent(
        claim.scopeKey,
        claim.itemId,
        claim.itemGeneration,
        claim.operation,
      );
      if (!row || row.claim_token !== claim.claimToken) return false;
      this.#sql.exec(
        `UPDATE memory_index_intent
         SET state = ?, mutation_id = ?, claim_token = NULL, next_attempt_at = ?
         WHERE scope_key = ? AND item_id = ? AND item_generation = ? AND operation = ?`,
        state,
        mutationId ?? null,
        now.getTime(),
        claim.scopeKey,
        claim.itemId,
        claim.itemGeneration,
        claim.operation,
      );
      this.#sql.exec(
        `INSERT INTO memory_vector_ledger (
          vector_id, scope_key, item_id, item_generation, operation, policy_id,
          mutation_id, state, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vector_id) DO UPDATE SET
           mutation_id = excluded.mutation_id,
           state = excluded.state,
           next_attempt_at = excluded.next_attempt_at`,
        claim.vectorId,
        claim.scopeKey,
        claim.itemId,
        claim.itemGeneration,
        claim.operation,
        MEMORY_EMBEDDING_POLICY_ID_V1,
        mutationId ?? null,
        state,
        now.getTime(),
      );
      return true;
    });
    this.armAfterCommit();
    return ok;
  }

  retryIndexIntent(claim: MemoryClaimedIndexIntentV1): boolean {
    this.open();
    const now = this.#now();
    const ok = this.#storage.transactionSync(() => {
      const row = this.indexIntent(
        claim.scopeKey,
        claim.itemId,
        claim.itemGeneration,
        claim.operation,
      );
      if (!row || row.claim_token !== claim.claimToken) return false;
      this.#sql.exec(
        `UPDATE memory_index_intent
         SET state = 'pending', claim_token = NULL, next_attempt_at = ?
         WHERE scope_key = ? AND item_id = ? AND item_generation = ? AND operation = ?`,
        now.getTime() + memoryJobBackoffMsV1(1),
        claim.scopeKey,
        claim.itemId,
        claim.itemGeneration,
        claim.operation,
      );
      return true;
    });
    this.armAfterCommit();
    return ok;
  }

  activeItemText(scopeKey: string, itemId: string): string | undefined {
    const row = this.item(scopeKey, itemId);
    if (!row || row.status !== "active") return undefined;
    return row.text;
  }

  subjectItems(scopeKey: string, subjectKey: string): MemoryItemRecordV1[] {
    this.open();
    return this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item
         WHERE scope_key = ? AND status = 'active' AND subject_key = ?
         ORDER BY id ASC`,
        scopeKey,
        subjectKey,
      )
      .toArray()
      .map((row) => this.recordOf(row));
  }

  retainedCapturedText(obligationId: string): string | undefined {
    return this.retainedSource(obligationId)?.captured_text;
  }

  pendingIndexCandidates(
    scopeKey: string,
    limit = MEMORY_PENDING_INDEX_PAGE_V1,
  ): MemoryItemRecordV1[] {
    this.open();
    const rows = this.#sql
      .exec<{ item_id: string }>(
        `SELECT item_id FROM memory_index_intent
         WHERE scope_key = ?
           AND operation = 'upsert'
           AND state IN ('pending', 'claimed', 'unconfirmed')
         ORDER BY item_id ASC
         LIMIT ?`,
        scopeKey,
        limit + 1,
      )
      .toArray();
    return rows.slice(0, limit).flatMap((row) => {
      const item = this.item(scopeKey, row.item_id);
      return item && item.status === "active" ? [this.recordOf(item)] : [];
    });
  }

  semanticCoverage(scopeKey: string): MemorySemanticCoverageV1 {
    return this.semanticCoverageFor([scopeKey]);
  }

  /** Current invalidation fence for one scope. Callers recheck cached blocks. */
  scopeEpoch(scopeKey: string): number {
    this.open();
    return this.invalidationEpoch(scopeKey);
  }

  /** True when that generation is still the active item. */
  itemStillActive(
    scope: MemoryScopeRefV1,
    itemId: string,
    generation: number,
  ): boolean {
    return this.itemVisibility(scope, itemId, generation) === "active";
  }

  /**
   * `absent` means this owner does not store the row. Callers must not treat
   * that as withdrawn: the item may live on the other owner.
   */
  itemVisibility(
    scope: MemoryScopeRefV1,
    itemId: string,
    generation: number,
  ): "active" | "inactive" | "absent" {
    this.open();
    const row = this.item(memoryScopeKeyV1(scope), itemId);
    if (!row) return "absent";
    if (row.status !== "active" || Number(row.generation) !== generation) {
      return "inactive";
    }
    return "active";
  }

  inspectJobs(): MemoryJobInspectV1[] {
    this.open();
    return this.#sql
      .exec<{
        id: string;
        kind: string;
        scope_key: string;
        source_ref: string | null;
        input_generation: number;
        state: string;
        attempt: number;
        next_attempt_at: number;
        claim_token: string | null;
        effect_ref: string | null;
        principal: string | null;
      }>(
        `SELECT id, kind, scope_key, source_ref, input_generation, state,
                attempt, next_attempt_at, claim_token, effect_ref, principal
         FROM memory_job ORDER BY id ASC`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        kind: row.kind as MemoryJobKindV1,
        scopeKey: row.scope_key,
        sourceRef: row.source_ref ?? undefined,
        inputGeneration: Number(row.input_generation),
        state: row.state as MemoryJobStateV1,
        attempt: Number(row.attempt),
        nextAttemptAt: Number(row.next_attempt_at),
        claimToken: row.claim_token ?? undefined,
        effectRef: row.effect_ref ?? undefined,
        principal: decodePrincipalV1(row.principal),
      }));
  }

  inspectIndexIntents(): MemoryIndexIntentInspectV1[] {
    this.open();
    return this.#sql
      .exec<{
        scope_key: string;
        item_id: string;
        item_generation: number;
        operation: string;
        vector_id: string;
        state: string;
        mutation_id: string | null;
        claim_token: string | null;
        next_attempt_at: number;
      }>(
        `SELECT scope_key, item_id, item_generation, operation, vector_id, state,
                mutation_id, claim_token, next_attempt_at
         FROM memory_index_intent ORDER BY item_id ASC, operation ASC`,
      )
      .toArray()
      .map((row) => ({
        scopeKey: row.scope_key,
        itemId: row.item_id,
        itemGeneration: Number(row.item_generation),
        operation: row.operation as "upsert" | "delete",
        vectorId: row.vector_id,
        state: row.state,
        mutationId: row.mutation_id ?? undefined,
        claimToken: row.claim_token ?? undefined,
        nextAttemptAt: Number(row.next_attempt_at),
      }));
  }

  inspectRetention(): Array<{
    obligationId: string;
    state: string;
    sourceId: string;
  }> {
    this.open();
    return this.#sql
      .exec<{
        obligation_id: string;
        state: string;
        source_id: string;
      }>(`SELECT obligation_id, state, source_id FROM memory_source_retention`)
      .toArray()
      .map((row) => ({
        obligationId: row.obligation_id,
        state: row.state,
        sourceId: row.source_id,
      }));
  }

  inspectOutbox(): Array<{ id: string; state: string }> {
    this.open();
    return this.#sql
      .exec<{ id: string; state: string }>(
        `SELECT id, state FROM memory_outbox ORDER BY id ASC`,
      )
      .toArray();
  }

  outboxPayload(outboxId: string): MemoryOutboxPayloadV1 | undefined {
    this.open();
    const row = this.#sql
      .exec<{ payload: string }>(
        `SELECT payload FROM memory_outbox WHERE id = ?`,
        outboxId,
      )
      .toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.payload) as MemoryOutboxPayloadV1;
    } catch {
      return undefined;
    }
  }

  inspectProjections(): Array<{
    scopeKey: string;
    name: string;
    body: string;
    manifest: MemoryLeafManifestV1[];
    epoch: number;
  }> {
    this.open();
    return this.#sql
      .exec<{
        scope_key: string;
        name: string;
        body: string;
        manifest: string;
        checked_invalidation_epoch: number;
      }>(
        `SELECT scope_key, name, body, manifest, checked_invalidation_epoch
         FROM memory_projection ORDER BY name ASC`,
      )
      .toArray()
      .map((row) => ({
        scopeKey: row.scope_key,
        name: row.name,
        body: row.body,
        manifest: decodeManifestV1(row.manifest),
        epoch: Number(row.checked_invalidation_epoch),
      }));
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

  private recallChannels(
    scopes: readonly MemoryScopeRefV1[],
    query: string,
    request: MemoryRecallRequestV1,
    budget: number,
  ): {
    channels: MemoryChannelCandidatesV1[];
    omissions: MemoryEngineOmissionV1[];
  } {
    const omissions: MemoryEngineOmissionV1[] = [];
    const fts: MemoryChannelCandidatesV1["ranked"] = [];
    let ftsFailed = false;
    const match = memoryMatchExpressionV1(query);
    const exact = memoryCanonicalKeyV1(query);
    const channelLimit = Math.min(
      budget,
      MEMORY_POLICY_V1.candidatesPerChannel,
    );
    for (const scope of scopes) {
      if (fts.length >= channelLimit) break;
      const scopeKey = memoryScopeKeyV1(scope);
      try {
        const ids: string[] = [];
        const byId = this.item(scopeKey, query);
        if (byId?.status === "active") ids.push(byId.id);
        const byKey = this.activeByKey(scopeKey, exact);
        if (byKey && !ids.includes(byKey.id)) ids.push(byKey.id);
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
              channelLimit,
            )
            .toArray();
          for (const row of rows) {
            if (!ids.includes(row.id)) ids.push(row.id);
          }
        }
        for (const pending of this.pendingIndexCandidates(
          scopeKey,
          MEMORY_PENDING_INDEX_PAGE_V1,
        )) {
          if (ids.includes(pending.id)) continue;
          if (!memoryTextOverlapsV1(pending.text, query)) continue;
          ids.push(pending.id);
        }
        for (const id of ids) {
          if (fts.length >= channelLimit) break;
          fts.push({ scopeKey, itemId: id, rank: fts.length + 1 });
        }
      } catch (error) {
        ftsFailed = true;
        omissions.push({
          scope,
          reason:
            error instanceof Error
              ? error.message
              : "lexical recall failed for this scope",
        });
      }
    }
    const time: MemoryChannelCandidatesV1["ranked"] = [];
    const from = request.filters?.occurredFrom;
    const to = request.filters?.occurredTo;
    let timeStatus: MemoryRecallChannelStatusV1 = "skipped";
    if (from || to) {
      timeStatus = "complete";
      for (const scope of scopes) {
        if (time.length >= channelLimit) break;
        const scopeKey = memoryScopeKeyV1(scope);
        try {
          const rows = this.#sql
            .exec<{ id: string }>(
              `SELECT id FROM memory_item
               WHERE scope_key = ?
                 AND status = 'active'
                 AND occurred_at IS NOT NULL
                 ${from ? "AND occurred_at >= ?" : ""}
                 ${to ? "AND occurred_at <= ?" : ""}
               ORDER BY id ASC
               LIMIT ?`,
              scopeKey,
              ...(from ? [from] : []),
              ...(to ? [to] : []),
              channelLimit - time.length,
            )
            .toArray();
          for (const row of rows) {
            time.push({
              scopeKey,
              itemId: row.id,
              rank: time.length + 1,
            });
          }
        } catch (error) {
          timeStatus = time.length > 0 ? "partial" : "unavailable";
          omissions.push({
            scope,
            reason:
              error instanceof Error
                ? error.message
                : "time recall failed for this scope",
          });
        }
      }
    }
    const allowed = new Set(scopes.map((scope) => memoryScopeKeyV1(scope)));
    const semantic = (request.semanticRanks ?? [])
      .filter((rank) => allowed.has(rank.scopeKey))
      .slice(0, channelLimit)
      .map((rank, index): MemorySemanticRankV1 => ({
        scopeKey: rank.scopeKey,
        itemId: rank.itemId,
        rank: index + 1,
      }));
    const semanticStatus: MemoryRecallChannelStatusV1 =
      request.semanticStatus ??
      (request.semanticRanks ? "complete" : "skipped");
    return {
      channels: [
        {
          channel: "fts",
          status: ftsFailed
            ? fts.length > 0
              ? "partial"
              : "unavailable"
            : "complete",
          ranked: fts,
        },
        { channel: "semantic", status: semanticStatus, ranked: semantic },
        { channel: "time", status: timeStatus, ranked: time },
      ],
      omissions,
    };
  }

  private fusionItem(row: ItemRow): FusionMemoryItemV1 {
    const leaves =
      row.kind === "observation"
        ? this.#sql
            .exec<{ leaf_item_id: string }>(
              `SELECT leaf_item_id FROM memory_derivation
               WHERE scope_key = ? AND derived_id = ?`,
              row.scope_key,
              row.id,
            )
            .toArray()
            .map((leaf) => ({ itemId: leaf.leaf_item_id }))
        : [];
    const outgoing = this.#sql
      .exec<{ to_id: string }>(
        `SELECT to_id FROM memory_relation
         WHERE scope_key = ? AND from_id = ? AND relation = 'contradicts'`,
        row.scope_key,
        row.id,
      )
      .toArray();
    const incoming = this.#sql
      .exec<{ from_id: string }>(
        `SELECT from_id FROM memory_relation
         WHERE scope_key = ? AND to_id = ? AND relation = 'contradicts'`,
        row.scope_key,
        row.id,
      )
      .toArray();
    return {
      scopeKey: row.scope_key,
      itemId: row.id,
      kind: row.kind as FusionMemoryItemV1["kind"],
      text: row.text,
      leaves,
      contradicts: [
        ...outgoing.map((entry) => entry.to_id),
        ...incoming.map((entry) => entry.from_id),
      ],
    };
  }

  private recallNeighbors(
    scopes: readonly MemoryScopeRefV1[],
    seedIds: ReadonlySet<string>,
  ): MemoryNeighborV1[] {
    const neighbors: MemoryNeighborV1[] = [];
    for (const scope of scopes) {
      const scopeKey = memoryScopeKeyV1(scope);
      for (const seed of seedIds) {
        if (neighbors.length >= MEMORY_POLICY_V1.graphExpansionRecords) {
          return neighbors;
        }
        const rows = this.#sql
          .exec<{ to_id: string; relation: string }>(
            `SELECT to_id, relation FROM memory_relation
             WHERE scope_key = ? AND from_id = ?
             LIMIT ?`,
            scopeKey,
            seed,
            MEMORY_POLICY_V1.graphExpansionRecords,
          )
          .toArray();
        for (const row of rows) {
          neighbors.push({
            scopeKey,
            itemId: row.to_id,
            relation: row.relation,
          });
        }
      }
    }
    return neighbors.slice(0, MEMORY_POLICY_V1.graphExpansionRecords);
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
    leaves: ReadonlyArray<{ itemId: string }>,
  ): void {
    const ids = [...new Set(leaves.map((leaf) => leaf.itemId))].slice(
      0,
      MEMORY_MAX_LEAF_MANIFEST_V1,
    );
    for (const leafItemId of ids) {
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

  private writeRelations(
    scopeKey: string,
    fromId: string,
    relations: ReadonlyArray<{ relation: MemoryRelationV1; toId: string }>,
  ): void {
    for (const relation of relations) {
      this.#sql.exec(
        `INSERT INTO memory_relation (scope_key, from_id, relation, to_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        scopeKey,
        fromId,
        relation.relation,
        relation.toId,
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
    const vectorId = memoryItemVectorIdV1({
      scopeKey,
      itemId,
      generation,
    });
    if (operation === "upsert") {
      this.#sql.exec(
        `UPDATE memory_index_intent
         SET state = 'coalesced', next_attempt_at = ?
         WHERE scope_key = ? AND item_id = ? AND operation = 'upsert'
           AND item_generation < ? AND state IN ('pending', 'claimed')`,
        now.getTime(),
        scopeKey,
        itemId,
        generation,
      );
    }
    this.#sql.exec(
      `INSERT INTO memory_index_intent (
        scope_key, item_id, item_generation, operation, vector_id, state,
        mutation_id, next_attempt_at, claim_token)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
       ON CONFLICT (scope_key, item_id, item_generation, operation)
       DO UPDATE SET
         state = CASE
           WHEN memory_index_intent.state IN ('pending', 'claimed', 'failed')
           THEN 'pending'
           ELSE memory_index_intent.state
         END,
         next_attempt_at = CASE
           WHEN memory_index_intent.state IN ('pending', 'claimed', 'failed')
           THEN excluded.next_attempt_at
           ELSE memory_index_intent.next_attempt_at
         END`,
      scopeKey,
      itemId,
      generation,
      operation,
      vectorId,
      now.getTime() + MEMORY_JOB_WAKEUP_MS_V1,
    );
  }

  private queueJob(input: {
    id?: string;
    kind: string;
    scopeKey: string;
    sourceRef: string;
    inputGeneration: number;
    now: Date;
    principal?: MemoryJobPrincipalV1;
  }): void {
    const id = input.id ?? `${input.kind}:${input.scopeKey}:${input.sourceRef}`;
    this.#sql.exec(
      `INSERT INTO memory_job (
        id, kind, scope_key, source_ref, input_generation, state, attempt,
        next_attempt_at, claim_token, effect_ref, principal)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?)
       ON CONFLICT (id) DO UPDATE SET
         state = CASE
           WHEN memory_job.state IN ('pending', 'failed') THEN 'pending'
           ELSE memory_job.state
         END,
         next_attempt_at = CASE
           WHEN memory_job.state IN ('pending', 'failed')
           THEN excluded.next_attempt_at
           ELSE memory_job.next_attempt_at
         END,
         input_generation = CASE
           WHEN memory_job.state IN ('pending', 'failed')
           THEN excluded.input_generation
           ELSE memory_job.input_generation
         END,
         principal = COALESCE(memory_job.principal, excluded.principal)`,
      id,
      input.kind,
      input.scopeKey,
      input.sourceRef,
      input.inputGeneration,
      input.now.getTime() + MEMORY_JOB_WAKEUP_MS_V1,
      input.principal ? JSON.stringify(input.principal) : null,
    );
  }

  private captureLocalExtraction(input: {
    scopeKey: string;
    obligationId: string;
    request: MemoryCaptureExtractionRequestV1;
    captured: string;
    now: Date;
  }): MemoryCaptureResultV1 {
    this.ensureScope(input.scopeKey);
    const existing = this.job(input.obligationId);
    this.retainSource({
      scopeKey: input.scopeKey,
      obligationId: input.obligationId,
      source: input.request.source,
      captured: input.captured,
      now: input.now,
    });
    if (existing && existing.state !== "failed") {
      return {
        status: "ok",
        obligationId: input.obligationId,
        duplicate: true,
        queued: "extract",
      };
    }
    this.queueJob({
      id: input.obligationId,
      kind: "extract",
      scopeKey: input.scopeKey,
      sourceRef: input.obligationId,
      inputGeneration: this.scopeGeneration(input.scopeKey),
      now: input.now,
      principal: input.request.principal,
    });
    return {
      status: "ok",
      obligationId: input.obligationId,
      duplicate: false,
      queued: "extract",
    };
  }

  private retainSource(input: {
    scopeKey: string;
    obligationId: string;
    source: MemorySourceInputV1 & { capturedText?: string };
    captured: string;
    now: Date;
  }): void {
    this.#sql.exec(
      `INSERT INTO memory_source_retention (
        scope_key, source_id, source_revision, kind, locator, captured_text,
        captured_at, obligation_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retained')
       ON CONFLICT (scope_key, source_id, source_revision) DO UPDATE SET
         captured_text = excluded.captured_text,
         captured_at = excluded.captured_at,
         obligation_id = excluded.obligation_id,
         state = CASE
           WHEN memory_source_retention.state = 'released'
           THEN memory_source_retention.state
           ELSE 'retained'
         END`,
      input.scopeKey,
      input.source.sourceId,
      input.source.sourceRevision,
      input.source.kind,
      JSON.stringify(input.source.locator),
      input.captured,
      input.now.toISOString(),
      input.obligationId,
    );
  }

  private releaseRetention(obligationId: string): void {
    this.#sql.exec(
      `UPDATE memory_source_retention SET state = 'released'
       WHERE obligation_id = ?`,
      obligationId,
    );
  }

  private retainedSource(obligationId: string): RetentionRow | undefined {
    this.open();
    return this.#sql
      .exec<RetentionRow>(
        `SELECT * FROM memory_source_retention WHERE obligation_id = ? LIMIT 1`,
        obligationId,
      )
      .toArray()[0];
  }

  private job(id: string): JobRow | undefined {
    return this.#sql
      .exec<JobRow>(`SELECT * FROM memory_job WHERE id = ?`, id)
      .toArray()[0];
  }

  private dueJobs(
    kinds: readonly string[],
    now: Date,
    limit: number,
  ): JobRow[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(", ");
    return this.#sql
      .exec<JobRow>(
        `SELECT * FROM memory_job
         WHERE state IN ('pending', 'claimed')
           AND kind IN (${placeholders})
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, id ASC
         LIMIT ?`,
        ...kinds,
        now.getTime(),
        limit,
      )
      .toArray();
  }

  private claimJobRow(
    row: JobRow,
    now: Date,
    lane: "local" | "external",
  ): MemoryClaimedJobV1 {
    const claimToken = `${row.id}:${now.getTime()}:${Number(row.attempt) + 1}`;
    const nextAt =
      now.getTime() +
      (lane === "local"
        ? MEMORY_JOB_CONTINUATION_MS_V1
        : memoryJobBackoffMsV1(Number(row.attempt) + 1));
    this.#sql.exec(
      `UPDATE memory_job
       SET state = 'claimed', claim_token = ?, attempt = attempt + 1,
           next_attempt_at = ?
       WHERE id = ?`,
      claimToken,
      nextAt,
      row.id,
    );
    const principal = decodePrincipalV1(row.principal);
    const scope = decodeMemoryScopeKeyV1(row.scope_key);
    return {
      id: row.id,
      kind: row.kind as MemoryJobKindV1,
      scopeKey: row.scope_key,
      scope,
      ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
      inputGeneration: Number(row.input_generation),
      attempt: Number(row.attempt) + 1,
      claimToken,
      ...(row.effect_ref ? { effectRef: row.effect_ref } : {}),
      ...(principal ? { principal } : {}),
      authority: authorityFromPrincipalV1(principal, scope),
    };
  }

  private dueIndexIntent(now: Date): IndexIntentRow | undefined {
    return this.#sql
      .exec<IndexIntentRow>(
        `SELECT * FROM memory_index_intent
         WHERE state IN ('pending', 'claimed') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, item_id ASC
         LIMIT 1`,
        now.getTime(),
      )
      .toArray()[0];
  }

  private claimIndexIntent(
    row: IndexIntentRow,
    now: Date,
  ): MemoryClaimedIndexIntentV1 {
    const claimToken = `${row.vector_id}:${now.getTime()}`;
    this.#sql.exec(
      `UPDATE memory_index_intent
       SET state = 'claimed', claim_token = ?, next_attempt_at = ?
       WHERE scope_key = ? AND item_id = ? AND item_generation = ? AND operation = ?`,
      claimToken,
      now.getTime() + memoryJobBackoffMsV1(1),
      row.scope_key,
      row.item_id,
      row.item_generation,
      row.operation,
    );
    const item = this.item(row.scope_key, row.item_id);
    return {
      scopeKey: row.scope_key,
      itemId: row.item_id,
      itemGeneration: Number(row.item_generation),
      operation: row.operation as "upsert" | "delete",
      vectorId: row.vector_id,
      claimToken,
      ...(item && row.operation === "upsert" ? { text: item.text } : {}),
    };
  }

  private indexIntent(
    scopeKey: string,
    itemId: string,
    generation: number,
    operation: string,
  ): IndexIntentRow | undefined {
    return this.#sql
      .exec<IndexIntentRow>(
        `SELECT * FROM memory_index_intent
         WHERE scope_key = ? AND item_id = ? AND item_generation = ? AND operation = ?`,
        scopeKey,
        itemId,
        generation,
        operation,
      )
      .toArray()[0];
  }

  private readTopicProjection(
    scopeKey: string,
    topic: string,
    epoch: number,
  ): MemoryBrowseResultV1 | undefined {
    const projection = this.#sql
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
        `topic:${topic}`,
      )
      .toArray()[0];
    if (!projection) return undefined;
    const manifest = decodeManifestV1(projection.manifest);
    if (
      Number(projection.checked_invalidation_epoch) !== epoch &&
      !this.manifestValid(scopeKey, manifest)
    ) {
      return {
        sections: [],
        status: "unavailable",
        omissions: [
          {
            reason: "that topic page is no longer valid",
            scope: decodeMemoryScopeKeyV1(scopeKey),
          },
        ],
      };
    }
    try {
      const parsed = JSON.parse(projection.body) as {
        markdown?: string;
        sections?: MemoryBrowseSectionV1[];
      };
      if (parsed.sections && parsed.sections.length > 0) {
        return {
          sections: parsed.sections.slice(0, MEMORY_BROWSE_SECTIONS_V1),
          status: "complete",
          omissions: [],
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** A write bumps the scope generation without the invalidation epoch, so a still-valid older manifest hides the new item until the core is rebuilt. */
  private coreMatchesSelection(
    scopeKey: string,
    leaves: MemoryLeafManifestV1[],
  ): boolean {
    const selected = this.selectCoreItems(scopeKey);
    if (selected.length !== leaves.length) return false;
    return selected.every(
      (item, index) =>
        item.id === leaves[index]?.itemId &&
        Number(item.generation) === leaves[index]?.generation,
    );
  }

  private selectCoreItems(scopeKey: string): ItemRow[] {
    const rows = this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item
         WHERE scope_key = ? AND status = 'active'
         ORDER BY id ASC`,
        scopeKey,
      )
      .toArray();
    const profile: ItemRow[] = [];
    const observations: ItemRow[] = [];
    const rest: ItemRow[] = [];
    for (const row of rows) {
      if (isMemoryProfileSubjectV1(row.subject_key ?? undefined)) {
        profile.push(row);
      } else if (row.kind === "observation") {
        observations.push(row);
      } else {
        rest.push(row);
      }
    }
    const ordered = [...profile, ...observations, ...rest];
    const selected: ItemRow[] = [];
    let used = 0;
    for (const item of ordered) {
      const cost = memoryTokenEstimateV1(item.text);
      if (selected.length > 0 && used + cost > MEMORY_CORE_TOKEN_BUDGET_V1) {
        break;
      }
      selected.push(item);
      used += cost;
    }
    return selected;
  }

  private writeTopicProjection(
    scopeKey: string,
    subject: string,
    now: Date,
  ): void {
    const items = this.#sql
      .exec<ItemRow>(
        `SELECT * FROM memory_item
         WHERE scope_key = ? AND status = 'active' AND subject_key = ?
         ORDER BY recorded_at ASC, id ASC`,
        scopeKey,
        subject,
      )
      .toArray();
    const records = items.map((row) => this.recordOf(row));
    const groups = [records];
    const sections: MemoryBrowseSectionV1[] = groups
      .slice(0, MEMORY_BROWSE_SECTIONS_V1)
      .map((sectionItems) => {
        const manifest: MemoryLeafManifestV1[] = sectionItems
          .slice(0, MEMORY_MAX_LEAF_MANIFEST_V1)
          .map((item) => ({ itemId: item.id, generation: item.generation }));
        return {
          sectionId: subject,
          generation: this.invalidationEpoch(scopeKey),
          title: subject,
          summary: sectionItems
            .slice(0, 3)
            .map((item) => item.text)
            .join(" "),
          items: sectionItems,
          manifest,
        };
      });
    const markdown = [
      `# ${subject}`,
      ...records.map((item) => `- ${item.text}`),
    ].join("\n");
    this.putProjection({
      scopeKey,
      name: `topic:${subject}`,
      policyVersion: MEMORY_TOPIC_POLICY_VERSION_V1,
      epoch: this.invalidationEpoch(scopeKey),
      body: JSON.stringify({ markdown, sections }),
      manifest: sections.flatMap((section) => section.manifest),
      now,
    });
  }

  private putProjection(input: {
    scopeKey: string;
    name: string;
    policyVersion: number;
    epoch: number;
    body: string;
    manifest: MemoryLeafManifestV1[];
    now: Date;
  }): void {
    const existing = this.#sql
      .exec<{ body: string; generation: number }>(
        `SELECT body, generation FROM memory_projection
         WHERE scope_key = ? AND name = ?`,
        input.scopeKey,
        input.name,
      )
      .toArray()[0];
    const generation =
      existing && existing.body === input.body
        ? Number(existing.generation)
        : Number(existing?.generation ?? 0) + 1;
    this.#sql.exec(
      `INSERT INTO memory_projection (
        scope_key, name, generation, policy_version, checked_invalidation_epoch,
        body, manifest)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_key, name) DO UPDATE SET
         generation = excluded.generation,
         policy_version = excluded.policy_version,
         checked_invalidation_epoch = excluded.checked_invalidation_epoch,
         body = excluded.body,
         manifest = excluded.manifest`,
      input.scopeKey,
      input.name,
      generation,
      input.policyVersion,
      input.epoch,
      input.body,
      JSON.stringify(input.manifest),
    );
    void input.now;
  }

  private semanticCoverageFor(
    scopeKeys: readonly string[],
  ): MemorySemanticCoverageV1 {
    if (scopeKeys.length === 0) return "none";
    const placeholders = scopeKeys.map(() => "?").join(", ");
    const pending = this.#sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM memory_index_intent
         WHERE scope_key IN (${placeholders})
           AND state IN ('pending', 'claimed')
           AND operation = 'upsert'`,
        ...scopeKeys,
      )
      .toArray()[0];
    const unconfirmed = this.#sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM memory_index_intent
         WHERE scope_key IN (${placeholders})
           AND state = 'unconfirmed'`,
        ...scopeKeys,
      )
      .toArray()[0];
    const pendingCount = Number(pending?.n ?? 0);
    const unconfirmedCount = Number(unconfirmed?.n ?? 0);
    if (pendingCount > MEMORY_PENDING_INDEX_PAGE_V1) return "partial";
    if (pendingCount > 0 || unconfirmedCount > 0) return "unconfirmed";
    const any = this.#sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM memory_index_intent
         WHERE scope_key IN (${placeholders})`,
        ...scopeKeys,
      )
      .toArray()[0];
    return Number(any?.n ?? 0) === 0 ? "none" : "complete";
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

function extractionObligationIdV1(
  scopeKey: string,
  sourceId: string,
  sourceRevision: string,
): string {
  return `extract:${scopeKey}:${sourceId}@${sourceRevision}`;
}

function decodePrincipalV1(
  raw: string | null | undefined,
): MemoryJobPrincipalV1 | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MemoryJobPrincipalV1;
    if (
      typeof parsed.userId === "string" &&
      typeof parsed.botId === "string" &&
      (parsed.actor === "bot" || parsed.actor === "user")
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function authorityFromPrincipalV1(
  principal: MemoryJobPrincipalV1 | undefined,
  scope: MemoryScopeRefV1,
): MemoryAuthorityV1 {
  const userId = principal?.userId ?? scope.userId;
  const botId = principal?.botId ?? scope.botId ?? "bot";
  return {
    userId,
    botId,
    actor: principal?.actor ?? "bot",
    joinedGroupChatIds: scope.groupChatId ? [scope.groupChatId] : [],
    membershipRevision: "1",
  };
}

function decodeLocatorV1(raw: string, revision: string): MemorySourceLocatorV1 {
  try {
    return JSON.parse(raw) as MemorySourceLocatorV1;
  } catch {
    return { kind: "explicit", revision };
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
