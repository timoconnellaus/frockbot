// An in-memory `RoutineStorageV1`, for tests and for the gateway's fake
// authority. It is the Durable Object's storage contract and nothing more: a
// sorted key space, exact-key reads, and a transaction that rolls back.
import type { RoutineStorageV1, RoutineStorageWritesV1 } from "./store.js";
import { createTransactionalMapStorageV1 } from "../testkit/transactional-map.js";

export interface MemoryRoutineStorageV1 extends RoutineStorageV1 {
  /** Every key currently held, sorted. Useful for asserting trimming. */
  keys(): string[];
}

export function createMemoryRoutineStorageV1(): MemoryRoutineStorageV1 {
  return createTransactionalMapStorageV1<RoutineStorageWritesV1>();
}
