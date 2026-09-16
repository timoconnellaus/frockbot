// The Routines authority: the Bot Durable Object's durable Routine records.
//
// "The Bot's Durable Object is the authority for everything Bot-scoped: …
// durable scheduling, Routines, and Composition." This class is that authority's
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
  nextRoutineRunV1,
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
  type RoutineTriggerV1,
  type RoutineWriterV1,
} from "./records.js";
import {
  constantTimeEqualsV1,
  decodeRoutineHookKeyV1,
  renderRoutineDeliveryV1,
  RoutineHookError,
  ROUTINE_DELIVERY_LIMIT,
  ROUTINE_DELIVERY_TTL_MS,
  type RoutineDeliveryReceiptV1,
  type RoutineHookKeyV1,
} from "./hook.js";
import {
  ROUTINE_DELIVERY_PREFIX,
  ROUTINE_LIMIT_PER_BOT,
  ROUTINE_PREFIX,
  ROUTINE_RUN_LOG_LIMIT,
  routineFireKeyV1,
  routineKeyV1,
  routineQueuePrefixV1,
  routineReceiptKeyV1,
  routineRunKeyV1,
  routineRunPrefixV1,
  routineDeliveryKeyV1,
  routineHookKeyRecordV1,
  routineScheduleKeyV1,
  nextRunSequenceV1,
} from "./storage-keys.js";
import {
  routineCommandFingerprintV1,
  type RoutineCommandReceiptV1,
  type RoutineCommandV1,
  type RoutineHookMintV1,
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

/**
 * The receipt as it is stored. A minted key is on the one the caller receives
 * and on no other: a key a replay could re-read would not be a secret.
 */
function strippedReceipt(
  receipt: RoutineCommandReceiptV1,
): RoutineCommandReceiptV1 {
  if (receipt.status !== "applied" || receipt.hook === undefined) {
    return receipt;
  }
  const { hook: _hook, ...rest } = receipt;
  return rest;
}

interface StoredRoutineReceiptV1 {
  commandFingerprint: string;
  receipt: RoutineCommandReceiptV1;
}

/**
 * The scheduler, as the command path needs it. `routine/run` asks for a firing
 * and gets an id back; it never runs one itself, because the caller may be a
 * Turn already in flight. `RoutineScheduler` satisfies this structurally, so
 * the authority does not import the scheduler to hold one.
 */
/**
 * The minter, as the command path needs it. The token is derived from the
 * Worker secret and the Routine's identity, which the Durable Object holds and
 * this Package deliberately does not.
 */
export interface RoutineHookMinterV1 {
  mint(input: {
    routineId: string;
    keyVersion: number;
  }): Promise<{ token: string; digest: string; path: string }>;
}

export interface RoutineFiringSeamV1 {
  enqueueWithin(
    transaction: RoutineStorageWritesV1,
    input: {
      routineId: string;
      trigger: "manual" | "webhook";
      discriminator: string;
      delivery?: string;
    },
  ): Promise<{ fireId: string; queued: boolean }>;
}

/** One delivery, as a Plugin trigger is handed it (ADR 0026 step 8). */
export interface RoutinePluginTriggerDeliveryV1 {
  routineId: string;
  pluginId: string;
  trigger: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The Plugin worker, as a delivery reaches it. Outside any storage
 * transaction: a delivery is handed over between the door's checks and the
 * firing's write, never inside either.
 */
export interface RoutinePluginTriggerSeamV1 {
  deliver(
    input: RoutinePluginTriggerDeliveryV1,
  ): Promise<
    { status: "fire"; text: string } | { status: "drop"; reason?: string }
  >;
}

/** What the door answers. A replay answers with the first delivery's outcome. */
export type RoutineHookDeliveryReceiptV1 =
  | { status: "accepted" | "duplicate"; fireId: string }
  | { status: "dropped"; reason: string };

export interface RoutineStoreOptionsV1 {
  /** Injected so a test can pin a clock; production passes nothing. */
  now?(): Date;
  /** Injected so a test can pin an id; production passes nothing. */
  newRoutineId?(): string;
  /** Absent means `routine/run` is refused rather than silently doing nothing. */
  firings?: RoutineFiringSeamV1;
  /** Absent means a webhook Routine gets no key, and says so. */
  hookKeys?: RoutineHookMinterV1;
  /** Absent means a delivery to a Plugin-triggered Routine is refused. */
  pluginTriggers?: RoutinePluginTriggerSeamV1;
}

function writerView(writer: RoutineWriterV1): RoutineWriterViewV1 {
  // The Session and Turn travel with the Bot writer. A Routine a Bot wrote is
  // provenance, and provenance that cannot name the Turn it came from is only
  // half a record: "the Bot wrote this" is not answerable to "which Turn?".
  return writer.kind === "user"
    ? { kind: "user" }
    : {
        kind: "bot",
        botId: writer.botId,
        sessionId: writer.sessionId,
        turnId: writer.turnId,
      };
}

/**
 * The DTO for one record. Never carries key material, by construction.
 *
 * `nextRunAt` is passed in rather than computed: the scheduler owns the clock,
 * and a projection that recomputed one would be a second opinion on when the
 * Routine fires.
 */
export function routineViewV1(
  record: RoutineRecordV1,
  timezone: string,
  nextRunAt?: string,
  hookKeyVersion?: number,
): RoutineViewV1 {
  return {
    schemaVersion: 1,
    routineId: record.routineId,
    name: record.name,
    prompt: record.prompt,
    timezone,
    enabled: record.enabled,
    createdBy: writerView(record.createdBy),
    updatedBy: writerView(record.updatedBy),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.schedule === undefined ? {} : { schedule: record.schedule }),
    ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
    ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
    ...(nextRunAt === undefined ||
    !record.enabled ||
    record.schedule === undefined
      ? {}
      : { nextRunAt }),
    ...(hookKeyVersion === undefined ? {} : { hookKeyVersion }),
  };
}

/**
 * Append one entry to a Routine's run log, inside a transaction the caller
 * already holds, and trim the log to its bound.
 *
 * The scheduler writes the `running` entry in the same transaction that mints
 * the firing, and rewrites that entry when the firing settles, so it appends
 * through this rather than through `RoutineStore.recordRun`, which opens a
 * transaction of its own. An entry id that is already present is rewritten in
 * place: a settlement never appends a second row for a firing that has one.
 */
export async function appendRoutineRunEntryV1(
  transaction: RoutineStorageWritesV1,
  entry: RoutineRunEntryV1,
): Promise<void> {
  const decoded = decodeRoutineRunEntryV1(entry);
  const existing = await transaction.list<unknown>({
    prefix: routineRunPrefixV1(decoded.routineId),
  });
  const seen = [...existing.entries()].find(
    ([, value]) => decodeRoutineRunEntryV1(value).entryId === decoded.entryId,
  );
  if (seen) {
    await transaction.put(seen[0], decoded);
    return;
  }
  await transaction.put(
    routineRunKeyV1(decoded.routineId, nextRunSequenceV1([...existing.keys()])),
    decoded,
  );
  // Keys descend, so the oldest entries sort last.
  const keys = [...existing.keys()].sort();
  for (const key of keys.slice(ROUTINE_RUN_LOG_LIMIT - 1)) {
    await transaction.delete(key);
  }
}

export class RoutineStore {
  readonly #storage: RoutineStorageV1;
  readonly #now: () => Date;
  readonly #newRoutineId: () => string;
  readonly #firings: RoutineFiringSeamV1 | undefined;
  readonly #hookKeys: RoutineHookMinterV1 | undefined;
  readonly #pluginTriggers: RoutinePluginTriggerSeamV1 | undefined;
  readonly #inFlight = new Map<string, Promise<RoutineHookDeliveryReceiptV1>>();

  constructor(storage: RoutineStorageV1, options: RoutineStoreOptionsV1 = {}) {
    this.#storage = storage;
    this.#now = options.now ?? (() => new Date());
    this.#newRoutineId = options.newRoutineId ?? (() => crypto.randomUUID());
    this.#firings = options.firings;
    this.#pluginTriggers = options.pluginTriggers;
    this.#hookKeys = options.hookKeys;
  }

  /**
   * Every Routine this Bot holds, newest first. `nextRuns` comes from the
   * scheduler, so "next run" in the UI is the moment an alarm is actually armed
   * on and not a time this projection guessed.
   */
  async list(
    botId: string,
    nextRuns: ReadonlyMap<string, string> | undefined,
    timezone: string,
  ): Promise<RoutineListViewV1> {
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_PREFIX,
      limit: ROUTINE_LIMIT_PER_BOT,
    });
    const routines = [...stored.values()].map((value) =>
      decodeRoutineRecordV1(value),
    );
    const views: RoutineViewV1[] = [];
    for (const record of routines) {
      const key = await this.#storage.get<unknown>(
        routineHookKeyRecordV1(record.routineId),
      );
      views.push(
        routineViewV1(
          record,
          timezone,
          nextRuns?.get(record.routineId),
          key === undefined
            ? undefined
            : decodeRoutineHookKeyV1(key).keyVersion,
        ),
      );
    }
    views.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { schemaVersion: 1, botId, routines: views };
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
    await this.#storage.transaction((transaction) =>
      appendRoutineRunEntryV1(transaction, entry),
    );
  }

  /** One Routine's live webhook key record, or nothing. Never a token. */
  async readHookKey(routineId: string): Promise<RoutineHookKeyV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      routineHookKeyRecordV1(routineId),
    );
    return stored === undefined ? undefined : decodeRoutineHookKeyV1(stored);
  }

  /**
   * Accept one webhook delivery.
   *
   * The token already proved at the edge that it was minted by this deployment;
   * this is where it proves it is still *this Routine's* key. The durable record
   * is the authority, so a rotated or revoked key is refused here even though
   * its signature is perfectly good — which is what makes rotation and
   * revocation real rather than cosmetic.
   *
   * The replay guard, the firing and the receipt that lets a replay answer
   * with the firing already made are written in one transaction. A Plugin
   * trigger is asked in between, so the checks are read once before it is
   * asked and again before the firing is written.
   */
  async deliverHook(input: {
    routineId: string;
    keyVersion?: number;
    digest?: string;
    deliveryId: string;
    body: string;
    contentType?: string | null;
    headers?: Record<string, string>;
  }): Promise<RoutineHookDeliveryReceiptV1> {
    // A sender can have two copies of one event in the door at once, and the
    // Plugin is asked between the checks and the write. Without this the
    // second copy would ask the Plugin again for the firing the first is
    // already making; the replay guard only catches the copy that arrives
    // after that firing is written.
    const joined = this.#inFlight.get(input.deliveryId);
    if (joined !== undefined) {
      const already = await joined;
      return already.status === "accepted"
        ? { status: "duplicate", fireId: already.fireId }
        : already;
    }
    const delivering = this.#deliverHook(input).finally(() => {
      this.#inFlight.delete(input.deliveryId);
    });
    this.#inFlight.set(input.deliveryId, delivering);
    return delivering;
  }

  /**
   * The door's checks, all read in the one transaction so a key rotated or a
   * Routine paused between two reads cannot be seen half-way.
   */
  async #admitDelivery(
    transaction: RoutineStorageReadsV1,
    input: { routineId: string; keyVersion?: number; digest?: string },
  ): Promise<RoutineTriggerV1> {
    const stored = await transaction.get<unknown>(
      routineKeyV1(input.routineId),
    );
    if (stored === undefined) {
      throw new RoutineHookError(404, "Routine not found");
    }
    const record = decodeRoutineRecordV1(stored);
    const held = await transaction.get<unknown>(
      routineHookKeyRecordV1(input.routineId),
    );
    if (record.trigger === undefined || held === undefined)
      throw new RoutineHookError(401, "webhook key is invalid");
    const key = decodeRoutineHookKeyV1(held);
    if (
      key.keyVersion !== input.keyVersion ||
      !input.digest ||
      !constantTimeEqualsV1(key.digest, input.digest)
    )
      throw new RoutineHookError(401, "webhook key is invalid");
    if (!record.enabled) {
      // The key is good and the Routine is real; it is simply paused. That
      // is worth telling the caller, so a delivery can be retried later.
      throw new RoutineHookError(409, "Routine is paused");
    }
    return record.trigger;
  }

  async #deliverHook(input: {
    routineId: string;
    keyVersion?: number;
    digest?: string;
    deliveryId: string;
    body: string;
    contentType?: string | null;
    headers?: Record<string, string>;
  }): Promise<RoutineHookDeliveryReceiptV1> {
    if (!this.#firings) {
      throw new RoutineHookError(500, "this Bot cannot accept a delivery");
    }
    const firings = this.#firings;
    const receiptKey = routineDeliveryKeyV1(input.deliveryId);
    const replay = (
      seen: RoutineDeliveryReceiptV1,
    ): RoutineHookDeliveryReceiptV1 =>
      seen.fireId !== undefined
        ? { status: "duplicate", fireId: seen.fireId }
        : { status: "dropped", reason: seen.dropped ?? "dropped" };
    const admitted = await this.#storage.transaction(async (transaction) => {
      const now = this.#now();
      const trigger = await this.#admitDelivery(transaction, input);
      const seen = await transaction.get<RoutineDeliveryReceiptV1>(receiptKey);
      if (
        seen &&
        Date.parse(seen.acceptedAt) > now.getTime() - ROUTINE_DELIVERY_TTL_MS
      ) {
        return { replayed: replay(seen) };
      }
      return { trigger };
    });
    if (admitted.replayed !== undefined) return admitted.replayed;

    // A Plugin trigger is asked between the checks and the write, outside
    // both: the worker is another isolate, and a transaction cannot wait on it.
    let delivery = renderRoutineDeliveryV1(input.body, input.contentType);
    let dropped: string | undefined;
    if (admitted.trigger.kind === "plugin") {
      const seam = this.#pluginTriggers;
      if (!seam) {
        throw new RoutineHookError(500, "this Bot cannot reach its Plugins");
      }
      const answer = await seam.deliver({
        routineId: input.routineId,
        pluginId: admitted.trigger.pluginId,
        trigger: admitted.trigger.trigger,
        headers: input.headers ?? {},
        body: input.body,
      });
      if (answer.status === "drop") {
        dropped = (answer.reason ?? "the Plugin dropped the delivery").slice(
          0,
          1_024,
        );
      } else {
        delivery = renderRoutineDeliveryV1(answer.text, "text/plain");
      }
    }

    return this.#storage.transaction(async (transaction) => {
      const now = this.#now();
      // The checks are read again: the Plugin held the delivery for as long as
      // it liked, and a Routine paused or re-keyed while it answered must not
      // be fired on the strength of a check that has gone stale.
      await this.#admitDelivery(transaction, input);
      const seen = await transaction.get<RoutineDeliveryReceiptV1>(receiptKey);
      if (
        seen &&
        Date.parse(seen.acceptedAt) > now.getTime() - ROUTINE_DELIVERY_TTL_MS
      ) {
        return replay(seen);
      }
      if (dropped !== undefined) {
        await transaction.put(receiptKey, {
          schemaVersion: 1,
          routineId: input.routineId,
          dropped,
          acceptedAt: now.toISOString(),
        } satisfies RoutineDeliveryReceiptV1);
        await this.#trimDeliveries(transaction, now);
        return { status: "dropped" as const, reason: dropped };
      }
      const { fireId } = await firings.enqueueWithin(transaction, {
        routineId: input.routineId,
        trigger: "webhook",
        discriminator: `hook-${input.deliveryId.slice(0, 40)}`,
        delivery,
      });
      await transaction.put(receiptKey, {
        schemaVersion: 1,
        routineId: input.routineId,
        fireId,
        acceptedAt: now.toISOString(),
      } satisfies RoutineDeliveryReceiptV1);
      await this.#trimDeliveries(transaction, now);
      return { status: "accepted" as const, fireId };
    });
  }

  /** Keep the replay guard bounded, and drop what is past its window. */
  async #trimDeliveries(
    transaction: RoutineStorageWritesV1,
    now: Date,
  ): Promise<void> {
    const held = await transaction.list<RoutineDeliveryReceiptV1>({
      prefix: ROUTINE_DELIVERY_PREFIX,
    });
    const live: Array<[string, RoutineDeliveryReceiptV1]> = [];
    for (const [key, receipt] of held) {
      const acceptedAt = Date.parse(receipt?.acceptedAt ?? "");
      if (
        Number.isNaN(acceptedAt) ||
        acceptedAt <= now.getTime() - ROUTINE_DELIVERY_TTL_MS
      ) {
        await transaction.delete(key);
        continue;
      }
      live.push([key, receipt]);
    }
    if (live.length <= ROUTINE_DELIVERY_LIMIT) return;
    live.sort(
      ([, left], [, right]) =>
        Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt),
    );
    for (const [key] of live.slice(0, live.length - ROUTINE_DELIVERY_LIMIT)) {
      await transaction.delete(key);
    }
  }

  /**
   * Apply one command. The receipt is durable and fingerprinted, so a retry of
   * the same command id replays its outcome and a reused id carrying different
   * bytes is refused.
   */
  async execute(
    command: RoutineCommandV1,
    writer: RoutineWriterV1,
    timezone: string,
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
        receipt = await this.#apply(transaction, command, writer, timezone);
      } catch (error) {
        return { ok: false, error };
      }
      await transaction.put(receiptKey, {
        commandFingerprint: fingerprint,
        // The minted key is stripped before the receipt is stored. A key a
        // replay could re-read would not be a secret, so a replayed command id
        // answers with the Routine and no key at all.
        receipt: strippedReceipt(receipt),
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
    timezone: string,
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
      const draft: RoutineRecordV1 = {
        schemaVersion: 1,
        routineId,
        name: command.name,
        prompt: command.prompt,
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
      const record = this.#validated(draft, timezone);
      await transaction.put(routineKeyV1(routineId), record);
      // A triggered Routine — webhook or Plugin — is useless without a door
      // key, so creating one mints it in the same transaction. It is handed
      // back once and never stored.
      const minted =
        record.trigger === undefined
          ? undefined
          : await this.#mint(transaction, record.routineId, at);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        routine: routineViewV1(record, timezone, undefined, minted?.keyVersion),
        ...(minted ? { hook: minted.mint } : {}),
      };
    }

    const stored = await transaction.get<unknown>(
      routineKeyV1(command.routineId),
    );
    if (stored === undefined) throw new RoutineNotFoundError(command.routineId);
    const current = decodeRoutineRecordV1(stored);

    if (command.type === "routine/run") {
      if (!this.#firings) {
        throw new RoutineDecodeError(
          "this Bot cannot fire a Routine on demand",
        );
      }
      const { fireId } = await this.#firings.enqueueWithin(transaction, {
        routineId: command.routineId,
        trigger: "manual",
        discriminator: `manual-${command.commandId}`,
      });
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "fired",
        routineId: command.routineId,
        fireId,
      };
    }

    if (
      command.type === "routine/rotate-key" ||
      command.type === "routine/revoke-key"
    ) {
      if (current.trigger === undefined) {
        throw new RoutineDecodeError(
          `Routine "${command.routineId}" has no trigger to key`,
        );
      }
      if (command.type === "routine/revoke-key") {
        await transaction.delete(routineHookKeyRecordV1(command.routineId));
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          routine: routineViewV1(current, timezone),
        };
      }
      if (!this.#hookKeys) {
        throw new RoutineDecodeError(
          "this Bot cannot mint a webhook key; ROUTINE_HOOK_SECRET is not configured",
        );
      }
      const minted = await this.#mint(transaction, command.routineId, at);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        routine: routineViewV1(
          current,
          timezone,
          undefined,
          minted?.keyVersion,
        ),
        ...(minted ? { hook: minted.mint } : {}),
      };
    }

    if (command.type === "routine/delete") {
      await transaction.delete(routineKeyV1(command.routineId));
      // The key goes with the Routine: a delivery to a deleted Routine is a
      // 404 rather than a key that verifies against nothing.
      await transaction.delete(routineHookKeyRecordV1(command.routineId));
      const delivered = await transaction.list<{ routineId?: string }>({
        prefix: ROUTINE_DELIVERY_PREFIX,
      });
      for (const [key, receipt] of delivered) {
        if (receipt?.routineId === command.routineId) {
          await transaction.delete(key);
        }
      }
      // The clock, the unsettled firing and anything queued behind it go with
      // the record: nothing may fire a Routine that no longer exists.
      await transaction.delete(routineScheduleKeyV1(command.routineId));
      await transaction.delete(routineFireKeyV1(command.routineId));
      const waiting = await transaction.list<unknown>({
        prefix: routineQueuePrefixV1(command.routineId),
      });
      for (const key of waiting.keys()) await transaction.delete(key);
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
    const record = this.#validated(next, timezone);
    await transaction.put(routineKeyV1(record.routineId), record);
    // A Routine that has just become a webhook needs a key; one that has just
    // stopped being one must not keep a live door.
    let minted: { keyVersion: number; mint: RoutineHookMintV1 } | undefined;
    const held = await transaction.get<unknown>(
      routineHookKeyRecordV1(record.routineId),
    );
    if (record.trigger !== undefined && held === undefined) {
      minted = await this.#mint(transaction, record.routineId, at);
    } else if (record.trigger === undefined && held !== undefined) {
      await transaction.delete(routineHookKeyRecordV1(record.routineId));
    }
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      routine: routineViewV1(
        record,
        timezone,
        undefined,
        minted?.keyVersion ??
          (record.trigger !== undefined && held !== undefined
            ? decodeRoutineHookKeyV1(held).keyVersion
            : undefined),
      ),
      ...(minted ? { hook: minted.mint } : {}),
    };
  }

  /**
   * Mint the next key version for a Routine and record its digest.
   *
   * The plaintext leaves on the returned receipt and is written nowhere: the
   * durable record holds `SHA-256(token)` and the version, which is everything
   * a delivery needs to be checked and everything a rotation needs to retire.
   */
  async #mint(
    transaction: RoutineStorageWritesV1,
    routineId: string,
    at: string,
  ): Promise<{ keyVersion: number; mint: RoutineHookMintV1 } | undefined> {
    // A deployment with no signing secret can still record a webhook Routine;
    // it simply has no door key, and the delivery route refuses everything for
    // it. Recording the Routine and refusing the key is honest; minting a key
    // nothing could verify would not be.
    if (!this.#hookKeys) return undefined;
    const held = await transaction.get<unknown>(
      routineHookKeyRecordV1(routineId),
    );
    const keyVersion =
      held === undefined ? 1 : decodeRoutineHookKeyV1(held).keyVersion + 1;
    const { token, digest, path } = await this.#hookKeys.mint({
      routineId,
      keyVersion,
    });
    await transaction.put(routineHookKeyRecordV1(routineId), {
      schemaVersion: 1,
      routineId,
      keyVersion,
      digest,
      createdAt: at,
    } satisfies RoutineHookKeyV1);
    return {
      keyVersion,
      mint: { schemaVersion: 1, routineId, keyVersion, token, path },
    };
  }

  /**
   * The one gate every write passes. Syntax only: a schedule is parsed and a
   * timezone is resolved so a bad one is a rejected command rather than a dead
   * alarm, and nothing here computes a next firing.
   */
  #validated(record: RoutineRecordV1, timezone: string): RoutineRecordV1 {
    const decoded = decodeRoutineRecordV1(record);
    requireScheduleXorTriggerV1(decoded);
    if (decoded.schedule !== undefined) {
      let normalized;
      try {
        normalized = normalizeRoutineScheduleV1(decoded.schedule, timezone);
      } catch (error) {
        throw new RoutineDecodeError(
          error instanceof RoutineScheduleError
            ? error.message
            : `Routine schedule is invalid: ${String(error)}`,
        );
      }
      // A syntactically valid expression can still name a moment that never
      // arrives — `0 0 30 2 *` is February the 30th. It used to be accepted,
      // and then the clock fell back to "five minutes from now" on every claim,
      // so the Routine burned a whole model Turn every five minutes for ever.
      // A schedule that never comes around is not a schedule.
      const now = this.#now();
      if (nextRoutineRunV1(normalized, now, now) === undefined) {
        throw new RoutineDecodeError(
          `schedule "${decoded.schedule}" never comes around again in ${timezone}`,
        );
      }
    }
    return decoded;
  }
}
