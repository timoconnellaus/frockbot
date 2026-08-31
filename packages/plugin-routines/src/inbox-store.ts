// The completion inbox and the pending-input queue, as durable state.
//
// Two rules live here and nowhere else.
//
//  * **One terminal transaction.** `routineTerminalRecordsV1` is handed the
//    settled run and a reader bound to the transaction that is settling it, and
//    returns the records that transaction writes. The inbox entry, the pending
//    wake and the notification intent therefore become durable at the same
//    instant the automation Turn does, so there is no window in which a firing
//    has completed and its outcome is nowhere.
//
//  * **A drain happens once.** `drainInto` moves every pending input into a
//    receipt named by the run that drained it, in one transaction. A Turn that
//    is evicted and recovered reads its own receipt back rather than draining
//    again, so replay is idempotent on the input's id and the same model
//    request is reconstructed.
//
// Both bounds — 100 entries, 16 pending inputs — are retention, not
// correctness, so they are enforced when the records are next read rather than
// inside the settling transaction, which cannot list.
import {
  decodePendingBotInputV1,
  decodeRoutineInboxEntryV1,
  pendingBotInputIdV1,
  routineAttributionV1,
  ROUTINE_INBOX_TEXT_MAX,
  ROUTINE_WAKE_TITLE_MAX,
  type PendingBotInputV1,
  type RoutineInboxEntryV1,
} from "./inbox.js";
import { RoutineDecodeError } from "./records.js";
import type { RoutineStorageV1, RoutineStorageWritesV1 } from "./store.js";
import {
  routineDrainKeyV1,
  routineInboxKeyV1,
  routineSequenceCursorV1,
  routineWakeKeyV1,
  ROUTINE_DRAIN_PREFIX,
  ROUTINE_DRAIN_RECEIPT_LIMIT,
  ROUTINE_INBOX_CURSOR_KEY,
  ROUTINE_INBOX_LIMIT,
  ROUTINE_INBOX_PREFIX,
  ROUTINE_PENDING_INPUT_LIMIT,
  ROUTINE_WAKE_CURSOR_KEY,
  ROUTINE_WAKE_PREFIX,
} from "./storage-keys.js";

/** What one chat Turn drained, kept so a recovered Turn reproduces it. */
export interface RoutineDrainReceiptV1 {
  schemaVersion: 1;
  runId: string;
  drainedAt: string;
  inputs: PendingBotInputV1[];
}

function decodeDrainReceiptV1(value: unknown): RoutineDrainReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError("Routine drain receipt must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.runId !== "string") {
    throw new RoutineDecodeError("Routine drain receipt is invalid");
  }
  if (!Array.isArray(candidate.inputs)) {
    throw new RoutineDecodeError("Routine drain receipt inputs are invalid");
  }
  return {
    schemaVersion: 1,
    runId: candidate.runId,
    drainedAt: String(candidate.drainedAt),
    inputs: candidate.inputs.map((input) => decodePendingBotInputV1(input)),
  };
}

/** The settled automation Turn a terminal record set is computed from. */
export interface RoutineTerminalInputV1 {
  runId: string;
  routineId: string;
  routineName: string;
  /** The `wake_parent` hand-off, when the Turn made one. */
  handoff?: string;
  /** The Turn's own response text, used when it handed off nothing. */
  responseText?: string;
  now: string;
  read<T>(key: string): Promise<T | undefined>;
}

/** The records a settled automation Turn contributes, and what they say. */
export interface RoutineTerminalRecordsV1 {
  records: Record<string, unknown>;
  entry: RoutineInboxEntryV1;
  wake?: PendingBotInputV1;
}

function clamp(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length > maximum ? trimmed.slice(0, maximum) : trimmed;
}

/**
 * The inbox entry, the pending wake, and the two cursors they advance.
 *
 * A completed automation Turn always writes an entry — GrokBot's "silent final
 * message picked up at a natural safe boundary" — and writes a wake only when
 * the Turn called `wake_parent`, because only a hand-off is addressed to the
 * Bot rather than to the person reading the inbox.
 */
export async function routineTerminalRecordsV1(
  input: RoutineTerminalInputV1,
): Promise<RoutineTerminalRecordsV1 | undefined> {
  const text = clamp(
    input.handoff ??
      input.responseText ??
      "The Routine completed without leaving a message.",
    ROUTINE_INBOX_TEXT_MAX,
  );
  if (text.length === 0) return undefined;
  const inbox = routineSequenceCursorV1(
    await input.read<unknown>(ROUTINE_INBOX_CURSOR_KEY),
  );
  const wakeId = `rw-${input.runId}`;
  const entry: RoutineInboxEntryV1 = {
    schemaVersion: 1,
    entryId: `ri-${input.runId}`,
    runId: input.runId,
    routineId: input.routineId,
    text,
    attribution: routineAttributionV1(input.routineName),
    createdAt: input.now,
    acknowledged: false,
    ...(input.handoff === undefined ? {} : { wakeId }),
  };
  const records: Record<string, unknown> = {
    [routineInboxKeyV1(inbox.nextSeq)]: entry,
    [ROUTINE_INBOX_CURSOR_KEY]: {
      schemaVersion: 1,
      nextSeq: inbox.nextSeq + 1,
    },
  };
  if (input.handoff === undefined) return { records, entry };
  const wakes = routineSequenceCursorV1(
    await input.read<unknown>(ROUTINE_WAKE_CURSOR_KEY),
  );
  const wake: PendingBotInputV1 = {
    schemaVersion: 1,
    kind: "wake",
    wakeId,
    runId: input.runId,
    routineId: input.routineId,
    title: clamp(
      routineAttributionV1(input.routineName),
      ROUTINE_WAKE_TITLE_MAX,
    ),
    text,
    createdAt: input.now,
    quiet: { automation: true },
  };
  records[routineWakeKeyV1(wakes.nextSeq)] = wake;
  records[ROUTINE_WAKE_CURSOR_KEY] = {
    schemaVersion: 1,
    nextSeq: wakes.nextSeq + 1,
  };
  return { records, entry, wake };
}

export interface RoutineInboxStoreOptionsV1 {
  now?(): Date;
}

/** One pending input, with the key it is stored under. */
export interface StoredPendingInputV1 {
  key: string;
  input: PendingBotInputV1;
}

export class RoutineInboxStore {
  readonly #storage: RoutineStorageV1;
  readonly #now: () => Date;

  constructor(
    storage: RoutineStorageV1,
    options: RoutineInboxStoreOptionsV1 = {},
  ) {
    this.#storage = storage;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Every inbox entry, newest first, trimmed to the retention bound first so a
   * read is also the place the bound is enforced.
   */
  async list(): Promise<RoutineInboxEntryV1[]> {
    await this.#trimInbox();
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_INBOX_PREFIX,
      limit: ROUTINE_INBOX_LIMIT,
    });
    return [...stored.values()].map((value) =>
      decodeRoutineInboxEntryV1(value),
    );
  }

  /**
   * Mark entries read. Acknowledging is monotonic and idempotent: an entry that
   * is already acknowledged keeps the moment it was first acknowledged, so a
   * replayed command changes nothing.
   */
  async acknowledge(entryIds: readonly string[]): Promise<number> {
    const wanted = new Set(entryIds);
    const at = this.#now().toISOString();
    return this.#storage.transaction(async (transaction) => {
      const stored = await transaction.list<unknown>({
        prefix: ROUTINE_INBOX_PREFIX,
        limit: ROUTINE_INBOX_LIMIT,
      });
      let changed = 0;
      for (const [key, value] of stored.entries()) {
        const entry = decodeRoutineInboxEntryV1(value);
        if (entry.acknowledged) continue;
        if (wanted.size > 0 && !wanted.has(entry.entryId)) continue;
        await transaction.put(key, {
          ...entry,
          acknowledged: true,
          acknowledgedAt: at,
        } satisfies RoutineInboxEntryV1);
        changed += 1;
      }
      return changed;
    });
  }

  /** Every pending input, oldest first, with the key it lives under. */
  async pending(): Promise<StoredPendingInputV1[]> {
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_WAKE_PREFIX,
    });
    return [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, input: decodePendingBotInputV1(value) }));
  }

  /** Record that the alarm has re-emitted this wake's notification intent. */
  async markRenotified(key: string): Promise<void> {
    const at = this.#now().toISOString();
    await this.#storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) return;
      const input = decodePendingBotInputV1(stored);
      if (input.kind !== "wake" || input.renotifiedAt !== undefined) return;
      await transaction.put(key, {
        ...input,
        renotifiedAt: at,
      } satisfies PendingBotInputV1);
    });
  }

  /**
   * The durable inputs one chat Turn carries. The first call for a run moves
   * the queue into the run's receipt; every later call — a resumed Turn, a
   * recovered one — reads that receipt back and drains nothing, which is what
   * makes replay idempotent on the input's id.
   */
  async drainInto(runId: string): Promise<PendingBotInputV1[]> {
    const drainedAt = this.#now().toISOString();
    return this.#storage.transaction(async (transaction) => {
      const receiptKey = routineDrainKeyV1(runId);
      const existing = await transaction.get<unknown>(receiptKey);
      if (existing !== undefined) {
        return decodeDrainReceiptV1(existing).inputs;
      }
      const stored = await transaction.list<unknown>({
        prefix: ROUTINE_WAKE_PREFIX,
      });
      const pending = [...stored.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const seen = new Set<string>();
      const inputs: PendingBotInputV1[] = [];
      for (const [key, value] of pending) {
        await transaction.delete(key);
        const input = decodePendingBotInputV1(value);
        const id = pendingBotInputIdV1(input);
        if (seen.has(id)) continue;
        seen.add(id);
        inputs.push(input);
      }
      // Nothing owed, nothing recorded. A chat Turn holds the object's one
      // active run, so no firing can settle while it runs and no wake can
      // arrive behind this read; an empty receipt would be a record of nothing.
      if (inputs.length === 0) return [];
      const retained = inputs.slice(-ROUTINE_PENDING_INPUT_LIMIT);
      await transaction.put(receiptKey, {
        schemaVersion: 1,
        runId,
        drainedAt,
        inputs: retained,
      } satisfies RoutineDrainReceiptV1);
      await this.#trimReceipts(transaction, receiptKey);
      return retained;
    });
  }

  /** Trim the inbox to its retention bound, oldest first. */
  async #trimInbox(): Promise<void> {
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_INBOX_PREFIX,
    });
    const keys = [...stored.keys()].sort();
    if (keys.length <= ROUTINE_INBOX_LIMIT) return;
    for (const key of keys.slice(ROUTINE_INBOX_LIMIT)) {
      await this.#storage.delete(key);
    }
  }

  async #trimReceipts(
    transaction: RoutineStorageWritesV1,
    keep: string,
  ): Promise<void> {
    const stored = await transaction.list<unknown>({
      prefix: ROUTINE_DRAIN_PREFIX,
    });
    const keys = [...stored.keys()].filter((key) => key !== keep).sort();
    if (keys.length < ROUTINE_DRAIN_RECEIPT_LIMIT) return;
    for (const key of keys.slice(
      0,
      keys.length - ROUTINE_DRAIN_RECEIPT_LIMIT,
    )) {
      await transaction.delete(key);
    }
  }
}
