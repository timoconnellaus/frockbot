// Cloudflare Durable Object SQL adapter for canonical Memory.
//
// Alarm arming stays on the object's existing async alarm owner: SQLite
// `transactionSync` cannot enclose `setAlarm`. Jobs still carry `next_attempt_at`
// so eviction re-arms from the due index.

import { MemoryEngineV1 } from "@frockbot/app/memory/engine";
import {
  MemoryRecordsV1,
  type MemoryRemoteOwnerV1,
} from "@frockbot/app/memory/owner";
import type {
  MemoryBrowseRequestV1,
  MemoryBrowseResultV1,
  MemoryExpandRequestV1,
  MemoryExpandResultV1,
  MemoryForgetRequestV1,
  MemoryForgetResultV1,
  MemoryPreparedCoreRequestV1,
  MemoryPreparedCoreResultV1,
  MemoryRecallRequestV1,
  MemoryRecallResultV1,
  MemoryWriteRequestV1,
  MemoryWriteResultV1,
} from "@frockbot/app/memory/records";
import type { MemorySqlStorageV1 } from "@frockbot/app/memory/sql";
import { remoteCallV1 } from "@frockbot/core/contracts";

export interface DurableMemoryStorageV1 {
  sql: MemorySqlStorageV1["sql"];
  transactionSync<T>(callback: () => T): T;
}

export function durableObjectHasSqlV1(
  storage: object,
): storage is DurableMemoryStorageV1 {
  return (
    "sql" in storage &&
    typeof (storage as { transactionSync?: unknown }).transactionSync ===
      "function"
  );
}

export function createDurableMemoryStorageV1(
  storage: DurableMemoryStorageV1,
): MemorySqlStorageV1 {
  return {
    sql: storage.sql,
    transactionSync: (callback) => storage.transactionSync(callback),
  };
}

export function createBotMemoryEngineV1(
  storage: DurableMemoryStorageV1,
): MemoryEngineV1 {
  const engine = new MemoryEngineV1({
    storage: createDurableMemoryStorageV1(storage),
    ownedKinds: ["bot"],
  });
  engine.open();
  return engine;
}

export function createUserMemoryEngineV1(
  storage: DurableMemoryStorageV1,
): MemoryEngineV1 {
  const engine = new MemoryEngineV1({
    storage: createDurableMemoryStorageV1(storage),
    ownedKinds: ["user", "groupChat"],
  });
  engine.open();
  return engine;
}

export type MemoryOperateActionV1 =
  "write" | "forget" | "recall" | "expand" | "browse" | "preparedCore";

export interface UserMemoryRecordsRpc {
  operateMemory(input: unknown): Promise<unknown>;
}

export function createUserMemoryRecordsRemoteV1(
  rpc: UserMemoryRecordsRpc,
  identity: { userId: string; botId: string },
): MemoryRemoteOwnerV1 {
  const call = async <T>(
    action: MemoryOperateActionV1,
    request: unknown,
  ): Promise<T> =>
    remoteCallV1("shared Memory", () =>
      rpc.operateMemory({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        action,
        request,
      }),
    ) as Promise<T>;
  return {
    write: (request) => call<MemoryWriteResultV1>("write", request),
    forget: (request) => call<MemoryForgetResultV1>("forget", request),
    recall: (request) => call<MemoryRecallResultV1>("recall", request),
    expand: (request) => call<MemoryExpandResultV1>("expand", request),
    browse: (request) => call<MemoryBrowseResultV1>("browse", request),
    preparedCore: (request) =>
      call<MemoryPreparedCoreResultV1>("preparedCore", request),
  };
}

export function createBotMemoryRecordsV1(
  storage: DurableMemoryStorageV1,
  remote: MemoryRemoteOwnerV1,
): MemoryRecordsV1 {
  return new MemoryRecordsV1({
    owner: "bot",
    engine: createBotMemoryEngineV1(storage),
    remote,
  });
}

export function dispatchMemoryOperateV1(
  engine: MemoryEngineV1,
  action: MemoryOperateActionV1,
  request: unknown,
):
  | MemoryWriteResultV1
  | MemoryForgetResultV1
  | MemoryRecallResultV1
  | MemoryExpandResultV1
  | MemoryBrowseResultV1
  | MemoryPreparedCoreResultV1 {
  switch (action) {
    case "write":
      return engine.write(request as MemoryWriteRequestV1);
    case "forget":
      return engine.forget(request as MemoryForgetRequestV1);
    case "recall":
      return engine.recall(request as MemoryRecallRequestV1);
    case "expand":
      return engine.expand(request as MemoryExpandRequestV1);
    case "browse":
      return engine.browse(request as MemoryBrowseRequestV1);
    case "preparedCore":
      return engine.preparedCore(request as MemoryPreparedCoreRequestV1);
    default: {
      const exhausted: never = action;
      throw new Error(`unknown Memory action ${String(exhausted)}`);
    }
  }
}
