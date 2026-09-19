/** The low-level key/value seam shared by app authority test fixtures. */
export interface TransactionalMapWritesV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type TransactionalMapStorageV1<
  Writes extends TransactionalMapWritesV1 = TransactionalMapWritesV1,
> = Writes & {
  keys(): string[];
  transaction<T>(closure: (storage: Writes) => Promise<T>): Promise<T>;
};

/**
 * Create an in-memory sorted key space with Durable Object-like transactions.
 * The caller supplies the domain write type so its adapter keeps its own
 * storage interface and, where needed, a transaction's extra capabilities.
 */
export function createTransactionalMapStorageV1<
  Writes extends TransactionalMapWritesV1 = TransactionalMapWritesV1,
>(): TransactionalMapStorageV1<Writes> {
  const map = new Map<string, unknown>();
  const base: TransactionalMapWritesV1 = {
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
  return {
    ...base,
    keys: () => [...map.keys()].sort(),
    async transaction<T>(closure: (storage: Writes) => Promise<T>): Promise<T> {
      const snapshot = new Map(map);
      try {
        return await closure(base as Writes);
      } catch (error) {
        map.clear();
        for (const [key, value] of snapshot) map.set(key, value);
        throw error;
      }
    },
  } as TransactionalMapStorageV1<Writes>;
}
