// The Durable Object storage seam, as a Map, for tests that want the authority
// without a Durable Object. Transactions here do not roll back: every refusal
// the store makes happens before its first write, so there is nothing to undo.
import type { ChannelStorageV1 } from "./store.js";

export interface MemoryChannelStorageV1 extends ChannelStorageV1 {
  readonly map: Map<string, unknown>;
}

export function createMemoryChannelStorageV1(): MemoryChannelStorageV1 {
  const map = new Map<string, unknown>();
  const writes = {
    get: <T>(key: string) =>
      Promise.resolve(
        map.has(key) ? (structuredClone(map.get(key)) as T) : undefined,
      ),
    list: <T>(options: { prefix: string; limit?: number }) => {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
      return Promise.resolve(
        new Map(
          entries.map(([key, value]) => [key, structuredClone(value) as T]),
        ),
      );
    },
    put: (key: string, value: unknown) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(map.delete(key)),
  };
  return { ...writes, map, transaction: (closure) => closure(writes) };
}
