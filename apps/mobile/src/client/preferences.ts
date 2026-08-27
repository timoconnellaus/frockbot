export interface PreferenceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMemoryPreferenceStore(
  initial: Readonly<Record<string, string>> = {},
): PreferenceStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

export function createLocalStoragePreferenceStore(
  storage: Storage,
): PreferenceStore {
  return {
    get: (key) => Promise.resolve(storage.getItem(key)),
    set: (key, value) => {
      storage.setItem(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      storage.removeItem(key);
      return Promise.resolve();
    },
  };
}
