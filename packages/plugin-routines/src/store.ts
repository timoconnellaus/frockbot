// The Routines authority: the Bot Durable Object's durable Routine records.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, Assignments." This class is that authority's
// implementation; the Durable Object hands it a storage seam and calls it. It is
// a deep module: `execute`, `list` and `listRuns` are the whole surface, and
// every command — from the hosted client, from the `routine_manage` tool, from a
// replay — reaches the durable record through `execute` alone.
//
// Two rules are enforced here and nowhere else:
//
//  * Every durable write records its writer. A User write and a Bot write are
//    the same write with different provenance, and a Bot writer names the
//    Session and Turn that produced it.
//  * One command id applies once. The receipt is durable and fingerprinted, so
//    a retried command replays its recorded outcome and a reused key carrying
//    different bytes is an error rather than a silent second write.
//
// D1 fires nothing. There is no alarm, no cron evaluation beyond the syntax
// check a write must pass, and no webhook key: a webhook Routine records the
// trigger kind, and minting is D3's.
import {
  isRoutineTimezoneV1,
  normalizeRoutineScheduleV1,
  RoutineScheduleError,
} from "./cron.js";
import {
  decodeRoutineRecordV1,
  decodeRoutineRunEntryV1,
  isRoutineIdV1,
  requireScheduleXorTriggerV1,
  RoutineDecodeError,
  type RoutineRecordV1,
  type RoutineRunEntryV1,
  type RoutineWriterV1,
} from "./records.js";
import {
  ROUTINE_LIMIT_PER_BOT,
  ROUTINE_PREFIX,
  ROUTINE_RUN_LOG_LIMIT,
  routineKeyV1,
  routineReceiptKeyV1,
  routineRunKeyV1,
  routineRunPrefixV1,
  nextRunSequenceV1,
} from "./storage-keys.js";
import {
  routineCommandFingerprintV1,
  type RoutineCommandReceiptV1,
  type RoutineCommandV1,
  type RoutineListViewV1,
  type RoutineRunListViewV1,
  type RoutineViewV1,
  type RoutineWriterViewV1,
} from "./shared.js";

/** A Routine the Bot does not hold. */
export class RoutineNotFoundError extends Error {
  override readonly name = "RoutineNotFoundError";
  constructor(routineId: string) {
    super(`Routine "${routineId}" is unknown`);
  }
}

/** The reads a Routine listing needs. */
export interface RoutineStorageReadsV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

/** The writes one transaction performs. */
export interface RoutineStorageWritesV1 extends RoutineStorageReadsV1 {
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The Durable Object storage seam. `DurableObjectStorage` satisfies it. */
export interface RoutineStorageV1 extends RoutineStorageWritesV1 {
  transaction<T>(
    closure: (transaction: RoutineStorageWritesV1) => Promise<T>,
  ): Promise<T>;
}

interface StoredRoutineReceiptV1 {
  commandFingerprint: string;
  receipt: RoutineCommandReceiptV1;
}

export interface RoutineStoreOptionsV1 {
  /** The zone a Routine that names none is scheduled in. */
  defaultTimezone?: string;
  /** Injected so a test can pin a clock; production passes nothing. */
  now?(): Date;
  /** Injected so a test can pin an id; production passes nothing. */
  newRoutineId?(): string;
}

function writerView(writer: RoutineWriterV1): RoutineWriterViewV1 {
  return writer.kind === "user"
    ? { kind: "user" }
    : { kind: "bot", botId: writer.botId };
}

/** The DTO for one record. Never carries key material, by construction. */
export function routineViewV1(record: RoutineRecordV1): RoutineViewV1 {
  return {
    schemaVersion: 1,
    routineId: record.routineId,
    name: record.name,
    prompt: record.prompt,
    timezone: record.timezone,
    enabled: record.enabled,
    createdBy: writerView(record.createdBy),
    updatedBy: writerView(record.updatedBy),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.schedule === undefined ? {} : { schedule: record.schedule }),
    ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
    ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
  };
}

export class RoutineStore {
  readonly #storage: RoutineStorageV1;
  readonly #defaultTimezone: string;
  readonly #now: () => Date;
  readonly #newRoutineId: () => string;

  constructor(storage: RoutineStorageV1, options: RoutineStoreOptionsV1 = {}) {
    this.#storage = storage;
    this.#defaultTimezone = options.defaultTimezone ?? "UTC";
    this.#now = options.now ?? (() => new Date());
    this.#newRoutineId = options.newRoutineId ?? (() => crypto.randomUUID());
  }

  /** Every Routine this Bot holds, newest first. */
  async list(botId: string): Promise<RoutineListViewV1> {
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_PREFIX,
      limit: ROUTINE_LIMIT_PER_BOT,
    });
    const routines = [...stored.values()]
      .map((value) => routineViewV1(decodeRoutineRecordV1(value)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { schemaVersion: 1, botId, routines };
  }

  async read(routineId: string): Promise<RoutineRecordV1 | undefined> {
    if (!isRoutineIdV1(routineId)) {
      throw new RoutineDecodeError("Routine id is invalid");
    }
    const stored = await this.#storage.get<unknown>(routineKeyV1(routineId));
    return stored === undefined ? undefined : decodeRoutineRecordV1(stored);
  }

  /** One Routine's bounded run log, newest first. Empty until D2 fires one. */
  async listRuns(
    botId: string,
    routineId: string,
  ): Promise<RoutineRunListViewV1> {
    const record = await this.read(routineId);
    if (!record) throw new RoutineNotFoundError(routineId);
    const stored = await this.#storage.list<unknown>({
      prefix: routineRunPrefixV1(routineId),
      limit: ROUTINE_RUN_LOG_LIMIT,
    });
    return {
      schemaVersion: 1,
      botId,
      routineId,
      entries: [...stored.values()].map((value) => {
        const entry = decodeRoutineRunEntryV1(value);
        return {
          schemaVersion: 1 as const,
          entryId: entry.entryId,
          runId: entry.runId,
          trigger: entry.trigger,
          status: entry.status,
          startedAt: entry.startedAt,
          ...(entry.finishedAt === undefined
            ? {}
            : { finishedAt: entry.finishedAt }),
          ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        };
      }),
    };
  }

  /**
   * Append one entry to a Routine's run log and trim it to its bound.
   *
   * The log holds no authority: every entry names its `runId`, and the stored
   * run carries `admission.origin.routineId`, so the whole log is rebuildable
   * from the run index. Trimming loses index rows, never facts.
   */
  async recordRun(entry: RoutineRunEntryV1): Promise<void> {
    const decoded = decodeRoutineRunEntryV1(entry);
    await this.#storage.transaction(async (transaction) => {
      const existing = await transaction.list<unknown>({
        prefix: routineRunPrefixV1(decoded.routineId),
      });
      const seen = [...existing.entries()].find(
        ([, value]) =>
          decodeRoutineRunEntryV1(value).entryId === decoded.entryId,
      );
      if (seen) {
        // Settling a firing rewrites its own entry; it never appends a second.
        await transaction.put(seen[0], decoded);
        return;
      }
      await transaction.put(
        routineRunKeyV1(
          decoded.routineId,
          nextRunSequenceV1([...existing.keys()]),
        ),
        decoded,
      );
      // Keys descend, so the oldest entries sort last.
      const keys = [...existing.keys()].sort();
      for (const key of keys.slice(ROUTINE_RUN_LOG_LIMIT - 1)) {
        await transaction.delete(key);
      }
    });
  }

  /**
   * Apply one command. The receipt is durable and fingerprinted, so a retry of
   * the same command id replays its outcome and a reused id carrying different
   * bytes is refused.
   */
  async execute(
    command: RoutineCommandV1,
    writer: RoutineWriterV1,
  ): Promise<RoutineCommandReceiptV1> {
    const fingerprint = routineCommandFingerprintV1(command);
    // A refused command is returned out of the transaction rather than thrown
    // through it: every refusal happens before the first write, so rolling back
    // would be a no-op, and a transaction that rejects surfaces the failure
    // twice inside a Durable Object.
    const outcome = await this.#storage.transaction<
      | { ok: true; receipt: RoutineCommandReceiptV1 }
      | { ok: false; error: unknown }
    >(async (transaction) => {
      const receiptKey = routineReceiptKeyV1(command.commandId);
      const existing =
        await transaction.get<StoredRoutineReceiptV1>(receiptKey);
      if (existing) {
        if (existing.commandFingerprint !== fingerprint) {
          return {
            ok: false,
            error: new RoutineDecodeError(
              `Routine command idempotency key "${command.commandId}" was reused for a different command`,
            ),
          };
        }
        return { ok: true, receipt: existing.receipt };
      }
      let receipt: RoutineCommandReceiptV1;
      try {
        receipt = await this.#apply(transaction, command, writer);
      } catch (error) {
        return { ok: false, error };
      }
      await transaction.put(receiptKey, {
        commandFingerprint: fingerprint,
        receipt,
      } satisfies StoredRoutineReceiptV1);
      return { ok: true, receipt };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.receipt;
  }

  async #apply(
    transaction: RoutineStorageWritesV1,
    command: RoutineCommandV1,
    writer: RoutineWriterV1,
  ): Promise<RoutineCommandReceiptV1> {
    const at = this.#now().toISOString();
    if (command.type === "routine/create") {
      const held = await transaction.list<unknown>({
        prefix: ROUTINE_PREFIX,
        limit: ROUTINE_LIMIT_PER_BOT + 1,
      });
      if (held.size >= ROUTINE_LIMIT_PER_BOT) {
        throw new RoutineDecodeError(
          `a Bot may hold at most ${ROUTINE_LIMIT_PER_BOT} Routines`,
        );
      }
      const routineId = command.routineId ?? this.#newRoutineId();
      if (!isRoutineIdV1(routineId)) {
        throw new RoutineDecodeError("Routine id is invalid");
      }
      if (await transaction.get<unknown>(routineKeyV1(routineId))) {
        throw new RoutineDecodeError(`Routine "${routineId}" already exists`);
      }
      const timezone = command.timezone ?? this.#defaultTimezone;
      const draft: RoutineRecordV1 = {
        schemaVersion: 1,
        routineId,
        name: command.name,
        prompt: command.prompt,
        timezone,
        enabled: true,
        createdBy: writer,
        updatedBy: writer,
        createdAt: at,
        updatedAt: at,
        ...(command.schedule === undefined
          ? {}
          : { schedule: command.schedule }),
        ...(command.trigger === undefined ? {} : { trigger: command.trigger }),
      };
      const record = this.#validated(draft);
      await transaction.put(routineKeyV1(routineId), record);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        routine: routineViewV1(record),
      };
    }

    const stored = await transaction.get<unknown>(
      routineKeyV1(command.routineId),
    );
    if (stored === undefined) throw new RoutineNotFoundError(command.routineId);
    const current = decodeRoutineRecordV1(stored);

    if (command.type === "routine/delete") {
      await transaction.delete(routineKeyV1(command.routineId));
      const runs = await transaction.list<unknown>({
        prefix: routineRunPrefixV1(command.routineId),
      });
      for (const key of runs.keys()) await transaction.delete(key);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "deleted",
        routineId: command.routineId,
      };
    }

    let next: RoutineRecordV1;
    if (command.type === "routine/pause" || command.type === "routine/resume") {
      next = {
        ...current,
        enabled: command.type === "routine/resume",
        updatedBy: writer,
        updatedAt: at,
      };
    } else {
      // Partial update: an absent key leaves the durable field exactly as it
      // was. Naming a schedule clears a trigger and the reverse, because the
      // record may carry only one.
      const replacesTiming =
        command.schedule !== undefined || command.trigger !== undefined;
      next = {
        ...current,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
        ...(command.timezone === undefined
          ? {}
          : { timezone: command.timezone }),
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
        updatedBy: writer,
        updatedAt: at,
      };
      if (replacesTiming) {
        delete next.schedule;
        delete next.trigger;
        if (command.schedule !== undefined) next.schedule = command.schedule;
        if (command.trigger !== undefined) next.trigger = command.trigger;
      }
    }
    const record = this.#validated(next);
    await transaction.put(routineKeyV1(record.routineId), record);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      routine: routineViewV1(record),
    };
  }

  /**
   * The one gate every write passes. Syntax only: a schedule is parsed and a
   * timezone is resolved so a bad one is a rejected command rather than a dead
   * alarm, and nothing here computes a next firing.
   */
  #validated(record: RoutineRecordV1): RoutineRecordV1 {
    const decoded = decodeRoutineRecordV1(record);
    requireScheduleXorTriggerV1(decoded);
    if (!isRoutineTimezoneV1(decoded.timezone)) {
      throw new RoutineDecodeError(
        `timezone "${decoded.timezone}" is not an IANA time zone`,
      );
    }
    if (decoded.schedule !== undefined) {
      try {
        normalizeRoutineScheduleV1(decoded.schedule, decoded.timezone);
      } catch (error) {
        throw new RoutineDecodeError(
          error instanceof RoutineScheduleError
            ? error.message
            : `Routine schedule is invalid: ${String(error)}`,
        );
      }
    }
    return decoded;
  }
}
