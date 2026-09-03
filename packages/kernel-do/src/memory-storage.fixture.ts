/**
 * An in-memory `DurableObjectStorage` stand-in for kernel-do unit tests: the
 * same key/value, prefix-list, transaction, and alarm surface the authority
 * uses, with none of the workerd host. Eviction is modelled by constructing a
 * second authority over the same instance.
 */
export class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: {
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.end === undefined || key < options.end),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }

  /**
   * Transactions run one at a time, as a Durable Object's do. Two admissions
   * that arrive together must not both read "no run is pending" and both
   * write themselves into the slot, and a fixture that let them would prove
   * the opposite of what the tests are for.
   */
  #serialized: Promise<unknown> = Promise.resolve();

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const next = this.#serialized.then(
      () => callback(this),
      () => callback(this),
    );
    this.#serialized = next.catch(() => undefined);
    return next;
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}
