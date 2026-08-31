// An in-memory storage seam, for tests and for any host that needs the Durable
// Object's storage contract without a Durable Object: a sorted key space,
// exact-key reads, and a transaction that rolls back.
import type { TaskStorageV1, TaskStorageWritesV1 } from "./store.js";
import type { SubagentSlotTransaction } from "./quota.js";

export interface MemorySubagentStorageV1 extends TaskStorageV1 {
  /** Every key currently held, sorted. Useful for asserting trimming. */
  keys(): string[];
}

function reads(map: Map<string, unknown>): TaskStorageWritesV1 {
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

export function createMemorySubagentStorageV1(): MemorySubagentStorageV1 {
  const map = new Map<string, unknown>();
  const base = reads(map);
  return {
    ...base,
    keys: () => [...map.keys()].sort(),
    async transaction<T>(
      closure: (
        transaction: TaskStorageWritesV1 & SubagentSlotTransaction,
      ) => Promise<T>,
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
  } satisfies MemorySubagentStorageV1;
}
