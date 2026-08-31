// An in-memory `RoutineStorageV1`, for tests and for the gateway's fake
// authority. It is the Durable Object's storage contract and nothing more: a
// sorted key space, exact-key reads, and a transaction that rolls back.
import type { RoutineStorageV1, RoutineStorageWritesV1 } from "./store.js";

export interface MemoryRoutineStorageV1 extends RoutineStorageV1 {
  /** Every key currently held, sorted. Useful for asserting trimming. */
  keys(): string[];
}

function reads(map: Map<string, unknown>): RoutineStorageWritesV1 {
  return {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(map.get(key) as T | undefined);
    },
    list<T>(options: {
      prefix: string;
      limit?: number;
    }): Promise<Map<string, T>> {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
      return Promise.resolve(new Map(entries as Array<[string, T]>));
    },
    put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(map.delete(key));
    },
  };
}

export function createMemoryRoutineStorageV1(): MemoryRoutineStorageV1 {
  const map = new Map<string, unknown>();
  const base = reads(map);
  return {
    ...base,
    keys: () => [...map.keys()].sort(),
    async transaction<T>(
      closure: (transaction: RoutineStorageWritesV1) => Promise<T>,
    ): Promise<T> {
      const snapshot = new Map(map);
      try {
        return await closure(base);
      } catch (error) {
        map.clear();
        for (const [key, value] of snapshot) map.set(key, value);
        throw error;
      }
    },
  };
}
