// The Bot Durable Object's background-process records.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped … the
// append-only event log, the resumable execution cursor, idempotency records".
// A background process is Bot-scoped durable state of exactly that kind: it
// outlives its Turn, and after a Durable Object eviction the record is the only
// thing that knows the process was ever launched.
//
// A deep, small module: `record`, `read`, `update`, `delete`, `list`. Every
// write goes through a decoder, so a value that reaches storage is a value the codec
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
    let held = await this.storage.list<unknown>({
      prefix: COMPUTER_PROCESS_PREFIX,
      limit: COMPUTER_PROCESS_LIMIT_PER_BOT + 1,
    });
    if (
      held.size >= COMPUTER_PROCESS_LIMIT_PER_BOT &&
      !held.has(computerProcessKeyV1(decoded.processId))
    ) {
      // A finished process's record has already answered every question
      // anyone can ask of it. Without this prune the hundredth background
      // command a Bot ever ran disabled `computer_exec{background:true}`
      // permanently: no tool, no command and no UI could forget a record.
      held = await this.prune(held, decoded.processId);
    }
    if (
      held.size >= COMPUTER_PROCESS_LIMIT_PER_BOT &&
      !held.has(computerProcessKeyV1(decoded.processId))
    ) {
      throw new ComputerProcessLimitError(
        `this Bot already has ${COMPUTER_PROCESS_LIMIT_PER_BOT} background processes that have not finished; stop one with computer_process_stop first`,
      );
    }
    await this.storage.put(computerProcessKeyV1(decoded.processId), decoded);
  }

  /**
   * Drops finished records, oldest first, until the cap has room again.
   *
   * Terminal only: a `starting` or `running` record is the only thing that
   * remembers the process exists, so it is never pruned to make space. An
   * undecodable row goes too — it can answer nothing, and leaving it would let
   * one bad value hold a slot for the life of the Bot.
   */
  private async prune(
    held: Map<string, unknown>,
    incoming: string,
  ): Promise<Map<string, unknown>> {
    const terminal: Array<{ key: string; startedAt: string }> = [];
    for (const [key, value] of held) {
      if (key === computerProcessKeyV1(incoming)) continue;
      try {
        const record = decodeComputerProcessRecordV1(value);
        if (record.status === "exited" || record.status === "unknown") {
          terminal.push({ key, startedAt: record.startedAt });
        }
      } catch (error) {
        if (!(error instanceof ComputerProcessDecodeError)) throw error;
        terminal.push({ key, startedAt: "" });
      }
    }
    terminal.sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
    const remaining = new Map(held);
    for (const { key } of terminal) {
      if (remaining.size < COMPUTER_PROCESS_LIMIT_PER_BOT) break;
      await this.storage.delete(key);
      remaining.delete(key);
    }
    return remaining;
  }

  /**
   * Forgets one record. The process it described is over: the caller has read
   * a terminal status, or is reconciling an intent whose launch never ran.
   */
  async delete(processId: string): Promise<void> {
    await this.storage.delete(computerProcessKeyV1(processId));
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
