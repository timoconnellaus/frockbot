// The Bot Durable Object's background-process records.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped … the
// append-only event log, the resumable execution cursor, idempotency records".
// A background process is Bot-scoped durable state of exactly that kind: it
// outlives its Turn, and after a Durable Object eviction the record is the only
// thing that knows the process was ever launched.
//
// A deep, small module: `record`, `read`, `update`, `list`. Every write goes
// through a decoder, so a value that reaches storage is a value the codec
// accepts, and a stored record the codec later refuses is a visible failure
// rather than a silently reshaped one.
import {
  COMPUTER_PROCESS_LIMIT_PER_BOT,
  COMPUTER_PROCESS_PREFIX,
  computerProcessKeyV1,
  decodeComputerProcessRecordV1,
  ComputerProcessDecodeError,
  type ComputerProcessRecordV1,
} from "./process-records.js";

/** The Durable Object storage seam. `DurableObjectStorage` satisfies it. */
export interface ComputerProcessStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

export class ComputerProcessLimitError extends Error {
  override readonly name = "ComputerProcessLimitError";
}

export class ComputerProcessStore {
  constructor(private readonly storage: ComputerProcessStorageV1) {}

  /**
   * Writes the intent to launch. It happens before anything runs on the
   * Computer, so an interrupted launch leaves a record to reconcile rather
   * than a process nothing remembers.
   */
  async record(intent: ComputerProcessRecordV1): Promise<void> {
    const decoded = decodeComputerProcessRecordV1(intent);
    const held = await this.storage.list<unknown>({
      prefix: COMPUTER_PROCESS_PREFIX,
      limit: COMPUTER_PROCESS_LIMIT_PER_BOT + 1,
    });
    if (
      held.size >= COMPUTER_PROCESS_LIMIT_PER_BOT &&
      !held.has(computerProcessKeyV1(decoded.processId))
    ) {
      throw new ComputerProcessLimitError(
        `this Bot already holds ${COMPUTER_PROCESS_LIMIT_PER_BOT} background process records; end or forget one first`,
      );
    }
    await this.storage.put(computerProcessKeyV1(decoded.processId), decoded);
  }

  async read(processId: string): Promise<ComputerProcessRecordV1 | undefined> {
    const held = await this.storage.get<unknown>(
      computerProcessKeyV1(processId),
    );
    if (held === undefined) return undefined;
    return decodeComputerProcessRecordV1(held);
  }

  /** Replaces one record. The caller has already decided the new shape. */
  async update(next: ComputerProcessRecordV1): Promise<void> {
    const decoded = decodeComputerProcessRecordV1(next);
    await this.storage.put(computerProcessKeyV1(decoded.processId), decoded);
  }

  /**
   * Every record this Bot holds, newest first. A stored value the codec
   * refuses is dropped from the listing and left in storage: a listing is a
   * projection, and losing a row is better than failing every read because one
   * record is malformed.
   */
  async list(): Promise<ComputerProcessRecordV1[]> {
    const held = await this.storage.list<unknown>({
      prefix: COMPUTER_PROCESS_PREFIX,
      limit: COMPUTER_PROCESS_LIMIT_PER_BOT,
    });
    const records: ComputerProcessRecordV1[] = [];
    for (const value of held.values()) {
      try {
        records.push(decodeComputerProcessRecordV1(value));
      } catch (error) {
        if (!(error instanceof ComputerProcessDecodeError)) throw error;
      }
    }
    return records.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }
}
