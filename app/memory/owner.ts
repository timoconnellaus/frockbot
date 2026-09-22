// Memory owner facade: Bot-local rows stay here; User and shared Group Chat
// rows live on the User Durable Object, reached with one bounded RPC.

import { MemoryEngineV1 } from "./engine.js";
import {
  authorizeMemoryScopeV1,
  type MemoryAuthorityV1,
  type MemoryBrowseRequestV1,
  type MemoryBrowseResultV1,
  type MemoryExpandRequestV1,
  type MemoryExpandResultV1,
  type MemoryForgetRequestV1,
  type MemoryForgetResultV1,
  type MemoryPreparedCoreRequestV1,
  type MemoryPreparedCoreResultV1,
  type MemoryRecallRequestV1,
  type MemoryRecallResultV1,
  type MemoryScopeRefV1,
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
  now?: () => Date;
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

  constructor(options: MemoryRecordsOptionsV1) {
    this.engine = options.engine;
    this.#owner = options.owner;
    this.#remote = options.remote;
  }

  nextWakeupAt(): number | undefined {
    return this.engine.nextWakeupAt();
  }

  ensureWakeup(): void {
    this.engine.ensureWakeup();
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
    const localResult =
      local.length > 0
        ? this.engine.recall({ ...request, scopes: local })
        : undefined;
    let remoteResult: MemoryRecallResultV1 | undefined;
    if (remote.length > 0) {
      if (!this.#remote) {
        omissions.push({
          reason: "shared Memory is unavailable",
        });
      } else {
        remoteResult = await this.#remote.recall({
          ...request,
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
    return {
      hits,
      status,
      omissions: mergedOmissions,
      membershipRevision: request.authority.membershipRevision,
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
