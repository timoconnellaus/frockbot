// An in-memory storage seam, for tests and for any host that needs the Durable
// Object's storage contract without a Durable Object: a sorted key space,
// exact-key reads, and a transaction that rolls back.
import type { TaskStorageV1, TaskStorageWritesV1 } from "./store.js";
import type { SubagentSlotTransaction } from "./quota.js";
import { createTransactionalMapStorageV1 } from "../testkit/transactional-map.js";

export interface MemorySubagentStorageV1 extends TaskStorageV1 {
  /** Every key currently held, sorted. Useful for asserting trimming. */
  keys(): string[];
}

export function createMemorySubagentStorageV1(): MemorySubagentStorageV1 {
  return createTransactionalMapStorageV1<
    TaskStorageWritesV1 & SubagentSlotTransaction
  >();
}
