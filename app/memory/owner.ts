// Memory owner facade: Bot-local rows stay here; User and shared Group Chat
// rows live on the User Durable Object, reached with one bounded RPC.

import { MemoryEngineV1 } from "./engine.js";
import { settleMemoryChannelsV1 } from "./hybrid.js";
import {
  MEMORY_POLICY_V1,
  memoryDeadlineMsV1,
} from "./policy.js";
import type { MemorySemanticSearchV1 } from "./semantic.js";
import {
  authorizeMemoryScopeV1,
  memoryScopeKeyV1,
  type MemoryAdmitOutboxRequestV1,
  type MemoryAdmitOutboxResultV1,
  type MemoryBrowseRequestV1,
  type MemoryBrowseResultV1,
  type MemoryCaptureExtractionRequestV1,
  type MemoryCaptureResultV1,
  type MemoryExpandRequestV1,
  type MemoryExpandResultV1,
  type MemoryForgetRequestV1,
  type MemoryForgetResultV1,
  type MemoryPreparedCoreRequestV1,
  type MemoryPreparedCoreResultV1,
  type MemoryRecallRequestV1,
  type MemoryRecallResultV1,
  type MemoryRecallChannelStatusV1,
  type MemoryScopeRefV1,
  type MemorySemanticRankV1,
  type MemoryWriteRequestV1,
  type MemoryWriteResultV1,
} from "./records.js";
import type { MemorySqlStorageV1 } from "./sql.js";

export type MemoryOwnerKindV1 = "bot" | "user";

export interface MemoryRemoteOwnerV1 {
  write(request: MemoryWriteRequestV1): Promise<MemoryWriteResultV1>;
  forget(request: MemoryForgetRequestV1): Promise<MemoryForgetResultV1>;
  recall(request: MemoryRecallRequestV1): Promise<MemoryRecallResultV1>;
  expand(request: MemoryExpandRequestV1): Promise<MemoryExpandResultV1>;
  browse(request: MemoryBrowseRequestV1): Promise<MemoryBrowseResultV1>;
  preparedCore(
    request: MemoryPreparedCoreRequestV1,
  ): Promise<MemoryPreparedCoreResultV1>;
}

export interface MemoryRecordsOptionsV1 {
  owner: MemoryOwnerKindV1;
  engine: MemoryEngineV1;
  remote?: MemoryRemoteOwnerV1;
  semantic?: MemorySemanticSearchV1;
  now?: () => Date;
}

function mergeRecallChannelsV1(
  left: MemoryRecallResultV1["channels"],
  right: MemoryRecallResultV1["channels"],
): MemoryRecallResultV1["channels"] {
  const worse = (
    a: MemoryRecallChannelStatusV1 | undefined,
    b: MemoryRecallChannelStatusV1 | undefined,
  ): MemoryRecallChannelStatusV1 => {
    const order: MemoryRecallChannelStatusV1[] = [
      "unavailable",
      "partial",
      "complete",
      "skipped",
    ];
    const rank = (status: MemoryRecallChannelStatusV1 | undefined) =>
      status ? order.indexOf(status) : order.indexOf("skipped");
    return rank(a) <= rank(b) ? (a ?? "skipped") : (b ?? "skipped");
  };
  if (!left && !right) return undefined;
  return {
    fts: worse(left?.fts, right?.fts),
    semantic: worse(left?.semantic, right?.semantic),
    time: worse(left?.time, right?.time),
  };
}

function ownsScope(owner: MemoryOwnerKindV1, scope: MemoryScopeRefV1): boolean {
  if (owner === "bot") return scope.kind === "bot";
  return scope.kind === "user" || scope.kind === "groupChat";
}

/**
 * One owner's public Memory surface. Chat reads Bot-local state and makes one
 * User RPC covering User and authorized shared scopes. Voice uses the same
 * APIs for its selected Bot.
 */
export class MemoryRecordsV1 {
  readonly engine: MemoryEngineV1;
  #owner: MemoryOwnerKindV1;
  #remote?: MemoryRemoteOwnerV1;
  #semantic?: MemorySemanticSearchV1;

  constructor(options: MemoryRecordsOptionsV1) {
    this.engine = options.engine;
    this.#owner = options.owner;
    this.#remote = options.remote;
    this.#semantic = options.semantic;
  }

  ensureWakeup(): void {
    this.engine.ensureWakeup();
  }

  nextWakeupAt(): number | undefined {
    return this.engine.nextWakeupAt();
  }

  captureExtraction(
    request: MemoryCaptureExtractionRequestV1,
  ): MemoryCaptureResultV1 {
    return this.engine.captureExtraction(request);
  }

  admitOutbox(request: MemoryAdmitOutboxRequestV1): MemoryAdmitOutboxResultV1 {
    return this.engine.admitOutbox(request);
  }

  async write(request: MemoryWriteRequestV1): Promise<MemoryWriteResultV1> {
    if (ownsScope(this.#owner, request.scope)) {
      return this.engine.write(request);
    }
    if (!this.#remote) {
      return {
        status: "refused",
        reason: "that Memory scope is not owned here",
      };
    }
    return this.#remote.write(request);
  }

  async forget(request: MemoryForgetRequestV1): Promise<MemoryForgetResultV1> {
    if (ownsScope(this.#owner, request.scope)) {
      return this.engine.forget(request);
    }
    if (!this.#remote) {
      return {
        status: "refused",
        reason: "that Memory scope is not owned here",
      };
    }
    return this.#remote.forget(request);
  }

  async recall(request: MemoryRecallRequestV1): Promise<MemoryRecallResultV1> {
    const local: MemoryScopeRefV1[] = [];
    const remote: MemoryScopeRefV1[] = [];
    const omissions: MemoryRecallResultV1["omissions"] = [];
    for (const scope of request.scopes) {
      const reason = authorizeMemoryScopeV1(request.authority, scope);
      if (reason) {
        omissions.push({ reason, scope });
        continue;
      }
      if (ownsScope(this.#owner, scope)) local.push(scope);
      else remote.push(scope);
    }
    const semantic = await this.semanticRanks(request, [...local, ...remote]);
    const ranked: MemoryRecallRequestV1 = {
      ...request,
      semanticRanks: semantic.ranks,
      semanticStatus: semantic.status,
    };
    const localResult =
      local.length > 0
        ? this.engine.recall({ ...ranked, scopes: local })
        : undefined;
    let remoteResult: MemoryRecallResultV1 | undefined;
    if (remote.length > 0) {
      if (!this.#remote) {
        omissions.push({
          reason: "shared Memory is unavailable",
        });
      } else {
        remoteResult = await this.#remote.recall({
          ...ranked,
          scopes: remote,
        });
      }
    }
    const hits = [...(localResult?.hits ?? []), ...(remoteResult?.hits ?? [])];
    const mergedOmissions = [
      ...omissions,
      ...(localResult?.omissions ?? []),
      ...(remoteResult?.omissions ?? []),
    ];
    const statuses = [localResult?.status, remoteResult?.status].filter(
      (value): value is NonNullable<typeof value> => value !== undefined,
    );
    const status =
      statuses.includes("unavailable") || statuses.includes("refused")
        ? statuses.includes("unavailable")
          ? "unavailable"
          : "refused"
        : hits.length === 0
          ? "empty"
          : statuses.includes("partial")
            ? "partial"
            : "complete";
    const ordered = hits
      .slice()
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
    return {
      hits: ordered,
      status,
      omissions: mergedOmissions,
      membershipRevision: request.authority.membershipRevision,
      semanticCoverage:
        localResult?.semanticCoverage === "partial" ||
        remoteResult?.semanticCoverage === "partial"
          ? "partial"
          : localResult?.semanticCoverage === "unconfirmed" ||
              remoteResult?.semanticCoverage === "unconfirmed"
            ? "unconfirmed"
            : (localResult?.semanticCoverage ?? remoteResult?.semanticCoverage),
      channels: mergeRecallChannelsV1(
        localResult?.channels,
        remoteResult?.channels,
      ),
      tokensEstimated:
        (localResult?.tokensEstimated ?? 0) +
        (remoteResult?.tokensEstimated ?? 0),
    };
  }

  private async semanticRanks(
    request: MemoryRecallRequestV1,
    scopes: readonly MemoryScopeRefV1[],
  ): Promise<{
    ranks: MemorySemanticRankV1[];
    status: MemoryRecallChannelStatusV1;
  }> {
    if (request.semanticRanks) {
      return {
        ranks: [...request.semanticRanks],
        status: request.semanticStatus ?? "complete",
      };
    }
    if (!this.#semantic || scopes.length === 0) {
      return { ranks: [], status: "skipped" };
    }
    const settled = await settleMemoryChannelsV1(
      scopes.map((scope) => ({
        run: (signal) =>
          this.#semantic!.search(
            memoryScopeKeyV1(scope),
            request.query,
            MEMORY_POLICY_V1.candidatesPerChannel,
            signal,
          ),
      })),
      {
        concurrency: MEMORY_POLICY_V1.concurrentRetrievalCalls,
        deadlineMs: memoryDeadlineMsV1(request.effort),
      },
    );
    const ranks: MemorySemanticRankV1[] = [];
    let missing = false;
    for (const [index, outcome] of settled.entries()) {
      const scope = scopes[index];
      if (!scope || outcome.status !== "complete" || !outcome.value) {
        missing = true;
        continue;
      }
      for (const hit of outcome.value) {
        if (ranks.length >= MEMORY_POLICY_V1.candidatesPerChannel) break;
        ranks.push({
          scopeKey: memoryScopeKeyV1(scope),
          itemId: hit.itemId,
          rank: ranks.length + 1,
        });
      }
    }
    return {
      ranks,
      status: missing ? (ranks.length > 0 ? "partial" : "unavailable") : "complete",
    };
  }

  async expand(request: MemoryExpandRequestV1): Promise<MemoryExpandResultV1> {
    const local = request.sourceRefs.filter((ref) =>
      ownsScope(this.#owner, ref.scope),
    );
    const remote = request.sourceRefs.filter(
      (ref) => !ownsScope(this.#owner, ref.scope),
    );
    const localResult =
      local.length > 0
        ? this.engine.expand({ ...request, sourceRefs: local })
        : undefined;
    let remoteResult: MemoryExpandResultV1 | undefined;
    if (remote.length > 0) {
      if (!this.#remote) {
        return {
          evidence: localResult?.evidence ?? [],
          omissions: [
            ...(localResult?.omissions ?? []),
            { reason: "shared Memory is unavailable" },
          ],
          status: "unavailable",
        };
      }
      remoteResult = await this.#remote.expand({
        ...request,
        sourceRefs: remote,
      });
    }
    const evidence = [
      ...(localResult?.evidence ?? []),
      ...(remoteResult?.evidence ?? []),
    ];
    const omissions = [
      ...(localResult?.omissions ?? []),
      ...(remoteResult?.omissions ?? []),
    ];
    const status =
      localResult?.status === "unavailable" ||
      remoteResult?.status === "unavailable"
        ? "unavailable"
        : localResult?.status === "refused" ||
            remoteResult?.status === "refused"
          ? "refused"
          : evidence.length === 0
            ? "empty"
            : omissions.length > 0
              ? "partial"
              : "complete";
    return { evidence, omissions, status };
  }

  async browse(request: MemoryBrowseRequestV1): Promise<MemoryBrowseResultV1> {
    if (ownsScope(this.#owner, request.scope)) {
      return this.engine.browse(request);
    }
    if (!this.#remote) {
      return {
        sections: [],
        status: "unavailable",
        omissions: [{ reason: "shared Memory is unavailable" }],
      };
    }
    return this.#remote.browse(request);
  }

  async preparedCore(
    request: MemoryPreparedCoreRequestV1,
  ): Promise<MemoryPreparedCoreResultV1> {
    const local = request.scopes.filter((scope) =>
      ownsScope(this.#owner, scope),
    );
    const remote = request.scopes.filter(
      (scope) => !ownsScope(this.#owner, scope),
    );
    const localResult =
      local.length > 0
        ? this.engine.preparedCore({ ...request, scopes: local })
        : undefined;
    let remoteResult: MemoryPreparedCoreResultV1 | undefined;
    if (remote.length > 0 && this.#remote) {
      remoteResult = await this.#remote.preparedCore({
        ...request,
        scopes: remote,
      });
    }
    return {
      blocks: [...(localResult?.blocks ?? []), ...(remoteResult?.blocks ?? [])],
      manifest: [
        ...(localResult?.manifest ?? []),
        ...(remoteResult?.manifest ?? []),
      ],
      omissions: [
        ...(localResult?.omissions ?? []),
        ...(remoteResult?.omissions ?? []),
        ...(remote.length > 0 && !this.#remote
          ? [{ reason: "shared Memory is unavailable" }]
          : []),
      ],
      status:
        (localResult?.blocks.length ?? 0) +
          (remoteResult?.blocks.length ?? 0) ===
        0
          ? "empty"
          : "complete",
    };
  }
}

export function createMemoryEngineV1(
  storage: MemorySqlStorageV1,
  options: {
    now?: () => Date;
    ownedKinds?: readonly ("bot" | "user" | "groupChat")[];
  } = {},
): MemoryEngineV1 {
  const engine = new MemoryEngineV1({
    storage,
    ...(options.now ? { now: options.now } : {}),
    ...(options.ownedKinds ? { ownedKinds: options.ownedKinds } : {}),
  });
  engine.open();
  engine.ensureWakeup();
  return engine;
}

export function inProcessMemoryRemoteV1(
  engine: MemoryEngineV1,
): MemoryRemoteOwnerV1 {
  return {
    write: (request) => Promise.resolve(engine.write(request)),
    forget: (request) => Promise.resolve(engine.forget(request)),
    recall: (request) => Promise.resolve(engine.recall(request)),
    expand: (request) => Promise.resolve(engine.expand(request)),
    browse: (request) => Promise.resolve(engine.browse(request)),
    preparedCore: (request) => Promise.resolve(engine.preparedCore(request)),
  };
}
