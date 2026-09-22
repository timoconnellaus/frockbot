/**
 * An in-memory `DurableObjectStorage` stand-in for core/durable unit tests: the
 * same key/value, prefix-list, transaction, and alarm surface the authority
 * uses, with none of the workerd host. Eviction is modelled by constructing a
 * second authority over the same instance.
 */
export class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;
  /** The next setAlarm rejects and the transaction that called it rolls back. */
  failNextAlarm = false;

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

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(key: string | string[]): Promise<boolean | number> {
    if (typeof key === "string")
      return Promise.resolve(this.values.delete(key));
    return Promise.resolve(
      key.filter((entry) => this.values.delete(entry)).length,
    );
  }

  list<T>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => {
        if (options.prefix !== undefined && !key.startsWith(options.prefix)) {
          return false;
        }
        if (options.start !== undefined && key < options.start) return false;
        if (options.end !== undefined && key >= options.end) return false;
        return true;
      })
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    const limited =
      options.limit === undefined ? entries : entries.slice(0, options.limit);
    return Promise.resolve(new Map(limited as Array<[string, T]>));
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
      () => this.#runTransaction(callback),
      () => this.#runTransaction(callback),
    );
    this.#serialized = next.catch(() => undefined);
    return next;
  }

  /**
   * A thrown callback undoes every write in the attempt, including the alarm.
   * Callers that mutate a value they read must `put` it; the snapshot is what
   * rolls back, and a half-written pending index must not survive the throw.
   */
  async #runTransaction<T>(
    callback: (storage: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    const snapshot = new Map(
      [...this.values].map(
        ([key, value]) => [key, structuredClone(value)] as const,
      ),
    );
    const alarmAt = this.alarmAt;
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of snapshot) this.values.set(key, value);
      this.alarmAt = alarmAt;
      throw error;
    }
  }

  setAlarm(scheduledTime: number): Promise<void> {
    if (this.failNextAlarm) {
      this.failNextAlarm = false;
      return Promise.reject(new Error("alarm write failed"));
    }
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}
