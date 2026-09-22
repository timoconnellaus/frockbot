// Background Memory processing: extraction, consolidation, indexing and
// prepared views. Canonical rows stay in the engine; this drain is the
// owner's alarm work. Model calls, embeddings and Vectorize stay outside
// the SQL transaction. No Memory DO and no direct provider client.

import type { EmbedMemory, MemoryVectorIndex } from "./types.js";
import {
  MemoryEngineV1,
  type MemoryClaimedIndexIntentV1,
  type MemoryClaimedJobV1,
} from "./engine.js";
import {
  MEMORY_EMBEDDING_POLICY_ID_V1,
  MEMORY_JOB_CONTINUATION_MS_V1,
  MEMORY_PENDING_INDEX_PAGE_V1,
  type MemoryConsolidatedObservationV1,
  type MemoryExtractedProposalV1,
  type MemoryJobPrincipalV1,
  type MemoryOutboxPayloadV1,
  type MemoryScopeRefV1,
} from "./records.js";

export interface MemoryExtractionDispatchV1 {
  obligationId: string;
  capturedText: string;
  principal: MemoryJobPrincipalV1;
  scope: MemoryScopeRefV1;
}

export interface MemoryConsolidationDispatchV1 {
  jobId: string;
  subjectKey: string;
  items: Array<{ itemId: string; text: string }>;
  principal: MemoryJobPrincipalV1;
  scope: MemoryScopeRefV1;
}

export interface MemoryProcessingAdaptersV1 {
  extract?: (
    input: MemoryExtractionDispatchV1,
  ) => Promise<readonly MemoryExtractedProposalV1[]>;
  consolidate?: (
    input: MemoryConsolidationDispatchV1,
  ) => Promise<MemoryConsolidatedObservationV1 | undefined>;
  embed?: EmbedMemory;
  vectors?: MemoryVectorIndex;
  principalExists?: (principal: MemoryJobPrincipalV1) => Promise<boolean>;
  membershipHolds?: (
    principal: MemoryJobPrincipalV1,
    scope: MemoryScopeRefV1,
  ) => Promise<boolean>;
  deliverOutbox?: (
    payload: MemoryOutboxPayloadV1,
    outboxId: string,
  ) => Promise<{ status: "ok" } | { status: "refused"; reason: string }>;
}

export interface MemoryDrainResultV1 {
  kind: "local" | "external" | "index" | "idle";
  processed: number;
  spent: number;
  continuationAt?: number;
  notes: string[];
}

export async function drainMemoryProcessingV1(
  engine: MemoryEngineV1,
  adapters: MemoryProcessingAdaptersV1 = {},
  now = new Date(),
): Promise<MemoryDrainResultV1> {
  engine.open();
  const claimed = engine.claimDueWork(now);
  if (claimed.kind === "idle") {
    return { kind: "idle", processed: 0, spent: 0, notes: [] };
  }
  if (claimed.kind === "local") {
    let processed = 0;
    for (const job of claimed.jobs) {
      if (!(await authorityStillHolds(engine, job, adapters))) {
        engine.completeClaimedJob(job, "blocked", {
          reason: "principal or destination membership is gone",
        });
        continue;
      }
      engine.runLocalJob(job);
      processed += 1;
    }
    return {
      kind: "local",
      processed,
      spent: 0,
      continuationAt: now.getTime() + MEMORY_JOB_CONTINUATION_MS_V1,
      notes: [],
    };
  }
  if (claimed.kind === "index") {
    const notes = await drainIndexIntent(engine, claimed.intent, adapters);
    return {
      kind: "index",
      processed: 1,
      spent: notes.includes("embedded") ? 1 : 0,
      notes,
    };
  }
  const job = claimed.jobs[0];
  if (!job) return { kind: "idle", processed: 0, spent: 0, notes: [] };
  const notes = await drainExternalJob(engine, job, adapters);
  return {
    kind: "external",
    processed: 1,
    spent: notes.includes("model") ? 1 : 0,
    notes,
  };
}

async function drainExternalJob(
  engine: MemoryEngineV1,
  job: MemoryClaimedJobV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<string[]> {
  if (!(await authorityStillHolds(engine, job, adapters))) {
    engine.completeClaimedJob(job, "blocked", {
      reason: "principal or destination membership is gone",
    });
    return ["blocked"];
  }
  if (job.kind === "outbox-deliver") {
    return drainOutbox(engine, job, adapters);
  }
  if (
    job.effectRef?.startsWith("dispatch:") &&
    !job.effectRef.startsWith("result:")
  ) {
    const stored = engine.jobResult<unknown>(job.id);
    if (!stored) {
      engine.completeClaimedJob(job, "blocked", {
        reason:
          "the model update was sent and its outcome is unknown; it is not repeated",
        releaseRetention: false,
      });
      return ["uncertain"];
    }
  }
  if (job.kind === "extract") {
    return drainExtract(engine, job, adapters);
  }
  if (job.kind === "consolidate") {
    return drainConsolidate(engine, job, adapters);
  }
  engine.retryClaimedJob(job, true);
  return ["unknown-kind"];
}

async function drainExtract(
  engine: MemoryEngineV1,
  job: MemoryClaimedJobV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<string[]> {
  const stored = engine.jobResult<MemoryExtractedProposalV1[]>(job.id);
  let proposals = stored;
  if (!proposals) {
    if (!adapters.extract || !job.principal) {
      engine.retryClaimedJob(job, false);
      return ["no-extractor"];
    }
    const captured = engine.retainedCapturedText(job.sourceRef ?? job.id);
    if (!captured) {
      engine.completeClaimedJob(job, "blocked", {
        reason: "captured source is no longer retained",
      });
      return ["missing-source"];
    }
    const effectRef = `dispatch:${job.id}`;
    if (!engine.markJobDispatched(job, effectRef)) {
      return ["stale-claim"];
    }
    try {
      proposals = [
        ...(await adapters.extract({
          obligationId: job.id,
          capturedText: captured,
          principal: job.principal,
          scope: job.scope,
        })),
      ];
    } catch {
      engine.completeClaimedJob(job, "blocked", {
        reason:
          "the model update was sent and its outcome is unknown; it is not repeated",
      });
      return ["uncertain"];
    }
    if (!engine.storeJobResult(job, proposals)) return ["stale-claim"];
  }
  engine.applyExtractedProposals(job, proposals);
  engine.completeClaimedJob(job, "done", { releaseRetention: true });
  return ["model", "extracted"];
}

async function drainConsolidate(
  engine: MemoryEngineV1,
  job: MemoryClaimedJobV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<string[]> {
  const stored = engine.jobResult<MemoryConsolidatedObservationV1>(job.id);
  let observation = stored;
  if (!observation) {
    if (!adapters.consolidate || !job.principal || !job.sourceRef) {
      engine.retryClaimedJob(job, false);
      return ["no-consolidator"];
    }
    const items = engine
      .subjectItems(job.scopeKey, job.sourceRef)
      .map((item) => ({ itemId: item.id, text: item.text }));
    if (items.length === 0) {
      engine.completeClaimedJob(job, "done");
      return ["empty-subject"];
    }
    if (!engine.markJobDispatched(job, `dispatch:${job.id}`)) {
      return ["stale-claim"];
    }
    try {
      observation = await adapters.consolidate({
        jobId: job.id,
        subjectKey: job.sourceRef,
        items,
        principal: job.principal,
        scope: job.scope,
      });
    } catch {
      engine.completeClaimedJob(job, "blocked", {
        reason:
          "the model update was sent and its outcome is unknown; it is not repeated",
      });
      return ["uncertain"];
    }
    if (!observation) {
      engine.completeClaimedJob(job, "done");
      return ["model", "skipped"];
    }
    if (!engine.storeJobResult(job, observation)) return ["stale-claim"];
  }
  engine.applyConsolidatedObservation(job, observation);
  engine.completeClaimedJob(job, "done");
  return ["model", "consolidated"];
}

async function drainOutbox(
  engine: MemoryEngineV1,
  job: MemoryClaimedJobV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<string[]> {
  if (!adapters.deliverOutbox || !job.sourceRef) {
    engine.retryClaimedJob(job, false);
    return ["no-outbox-adapter"];
  }
  const rows = engine.inspectOutbox().filter((row) => row.id === job.sourceRef);
  if (rows[0]?.state === "acked") {
    engine.completeClaimedJob(job, "done", { releaseRetention: true });
    return ["already-acked"];
  }
  const payload = engine.outboxPayload(job.sourceRef);
  if (!payload) {
    engine.completeClaimedJob(job, "blocked", {
      reason: "outbox payload is missing",
    });
    return ["missing-payload"];
  }
  const admitted = await adapters.deliverOutbox(payload, job.sourceRef);
  if (admitted.status !== "ok") {
    engine.retryClaimedJob(job, false);
    return ["outbox-refused"];
  }
  engine.acknowledgeOutbox(job.sourceRef);
  engine.completeClaimedJob(job, "done", { releaseRetention: true });
  return ["outbox-acked"];
}

async function drainIndexIntent(
  engine: MemoryEngineV1,
  intent: MemoryClaimedIndexIntentV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<string[]> {
  if (intent.operation === "delete") {
    if (!adapters.vectors) {
      engine.completeIndexIntent(intent, undefined, "unconfirmed");
      return ["no-vector-adapter", "unconfirmed"];
    }
    try {
      const result = await adapters.vectors.deleteByIds([intent.vectorId]);
      engine.completeIndexIntent(intent, mutationIdOf(result), "unconfirmed");
      return ["deleted", "unconfirmed"];
    } catch {
      engine.retryIndexIntent(intent);
      return ["delete-failed"];
    }
  }
  const current = engine.activeItemText(intent.scopeKey, intent.itemId);
  if (!current) {
    engine.completeIndexIntent(intent, undefined, "unconfirmed");
    return ["inactive"];
  }
  if (!adapters.embed || !adapters.vectors) {
    engine.completeIndexIntent(intent, undefined, "unconfirmed");
    return ["no-embedder", "unconfirmed"];
  }
  let values: number[][];
  try {
    values = await adapters.embed([current]);
  } catch {
    engine.retryIndexIntent(intent);
    return ["embed-failed"];
  }
  const vector = values[0];
  if (!vector) {
    engine.retryIndexIntent(intent);
    return ["embed-failed"];
  }
  const still = engine.activeItemText(intent.scopeKey, intent.itemId);
  if (still !== current) {
    engine.retryIndexIntent(intent);
    return ["generation-changed"];
  }
  try {
    const result = await adapters.vectors.upsert([
      {
        id: intent.vectorId,
        values: vector,
        namespace: intent.scopeKey,
        metadata: {
          scopeKey: intent.scopeKey,
          itemId: intent.itemId,
          generation: intent.itemGeneration,
          policyId: MEMORY_EMBEDDING_POLICY_ID_V1,
        },
      },
    ]);
    engine.completeIndexIntent(intent, mutationIdOf(result), "unconfirmed");
    return ["embedded", "unconfirmed"];
  } catch {
    engine.retryIndexIntent(intent);
    return ["upsert-failed"];
  }
}

async function authorityStillHolds(
  _engine: MemoryEngineV1,
  job: MemoryClaimedJobV1,
  adapters: MemoryProcessingAdaptersV1,
): Promise<boolean> {
  if (!job.principal) return true;
  if (
    adapters.principalExists &&
    !(await adapters.principalExists(job.principal))
  ) {
    return false;
  }
  if (
    adapters.membershipHolds &&
    !(await adapters.membershipHolds(job.principal, job.scope))
  ) {
    return false;
  }
  return true;
}

function mutationIdOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  return typeof record.mutationId === "string" ? record.mutationId : undefined;
}

export function memoryPendingBacklogExceedsPageV1(
  pendingCount: number,
): boolean {
  return pendingCount > MEMORY_PENDING_INDEX_PAGE_V1;
}
