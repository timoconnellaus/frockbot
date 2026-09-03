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

/**
 * Queue one durable input inside a transaction the caller already holds.
 *
 * Exported because the producer of the `approval` variant is another Package's
 * decision write, and that decision and the input it owes the Bot have to
 * become durable together: a decision recorded with nothing queued would be a
 * question answered that the Bot never hears the answer to.
 *
 * Idempotent on the input's id — an id already waiting writes nothing, so a
 * retried decision cannot tell the Bot the same thing twice.
 */
export async function enqueuePendingBotInputV1(
  transaction: RoutineStorageWritesV1,
  input: PendingBotInputV1,
): Promise<void> {
  const id = pendingBotInputIdV1(input);
  const stored = await transaction.list<unknown>({
    prefix: ROUTINE_WAKE_PREFIX,
  });
  for (const value of stored.values()) {
    if (pendingBotInputIdV1(decodePendingBotInputV1(value)) === id) return;
  }
  const cursor = routineSequenceCursorV1(
    await transaction.get<unknown>(ROUTINE_WAKE_CURSOR_KEY),
  );
  await transaction.put(routineWakeKeyV1(cursor.nextSeq), input);
  await transaction.put(ROUTINE_WAKE_CURSOR_KEY, {
    schemaVersion: 1,
    nextSeq: cursor.nextSeq + 1,
  });
}

export interface RoutineInboxStoreOptionsV1 {
  now?(): Date;
}

/** One pending input, with the key it is stored under. */
export interface StoredPendingInputV1 {
  key: string;
  input: PendingBotInputV1;
}

/**
 * The inputs one drain carries, under the pending-input bound.
 *
 * The bound exists so a burst cannot hand a single Turn an unbounded prompt,
 * and it used to be a flat `slice(-16)` over everything queued. But the four
 * input kinds are not interchangeable. A dropped `wake` still has an inbox
 * entry, so the user can read it and nothing is lost; an `approval`, a
 * `machine-result` or a `superseded-turn` writes no entry anywhere, so
 * dropping one silently loses a decision the user made or a result a machine
 * produced. Those are kept whole and the cap falls on the wakes alone — the
 * only kind that can be dropped and still be read.
 */
export function retainedPendingInputsV1(
  inputs: readonly PendingBotInputV1[],
): PendingBotInputV1[] {
  if (inputs.length <= ROUTINE_PENDING_INPUT_LIMIT) return [...inputs];
  const durable = inputs.filter((input) => input.kind !== "wake");
  const budget = ROUTINE_PENDING_INPUT_LIMIT - durable.length;
  if (budget <= 0) return durable;
  const keptWakes = new Set(
    inputs.filter((input) => input.kind === "wake").slice(-budget),
  );
  return inputs.filter(
    (input) => input.kind !== "wake" || keptWakes.has(input),
  );
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

  /**
   * Queue one durable input the Bot's next conversational Turn is owed.
   *
   * This is the seam the approval-card slice produces through: the queue was
   * always wider than Routines, and a second producer is not a second queue.
   * Idempotent on the input's id — an enqueue for an id already waiting writes
   * nothing, so a retried decision cannot tell the Bot the same thing twice.
   */
  async enqueue(input: PendingBotInputV1): Promise<void> {
    await this.#storage.transaction((transaction) =>
      enqueuePendingBotInputV1(transaction, input),
    );
  }

  /**
   * Appends one completion-inbox entry outside a settling transaction.
   *
   * Routines write their entry *inside* the transaction that settles the Turn,
   * because the Turn and its outcome are the same object's state. A background
   * subagent settles from a different Durable Object, so its entry is its own
   * transaction — and the property that matters is the same one: idempotent on
   * `entryId`, so a retried settle records one entry, not two.
   */
  async append(entry: RoutineInboxEntryV1): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      const stored = await transaction.list<unknown>({
        prefix: ROUTINE_INBOX_PREFIX,
      });
      for (const value of stored.values()) {
        if (decodeRoutineInboxEntryV1(value).entryId === entry.entryId) return;
      }
      const cursor = routineSequenceCursorV1(
        await transaction.get<unknown>(ROUTINE_INBOX_CURSOR_KEY),
      );
      await transaction.put(routineInboxKeyV1(cursor.nextSeq), entry);
      await transaction.put(ROUTINE_INBOX_CURSOR_KEY, {
        schemaVersion: 1,
        nextSeq: cursor.nextSeq + 1,
      });
    });
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
      const retained = retainedPendingInputsV1(inputs);
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

  /** Trim the inbox to its retention bound, acknowledged entries first. */
  async #trimInbox(): Promise<void> {
    const stored = await this.#storage.list<unknown>({
      prefix: ROUTINE_INBOX_PREFIX,
    });
    // Inbox keys are descending, so ascending key order is newest first and
    // the oldest entry is the last of them.
    const entries = [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .reverse();
    let excess = entries.length - ROUTINE_INBOX_LIMIT;
    if (excess <= 0) return;
    // Read entries go first, oldest read before newest, and only then unread
    // ones. Trimming purely by age used to drop a completion the reader had
    // never seen while a dozen they had already acknowledged sat beside it —
    // the inbox is the only place a firing ever speaks, so what has not been
    // read is the last thing to lose.
    const acknowledged: string[] = [];
    const unread: string[] = [];
    for (const [key, value] of entries) {
      let read = false;
      try {
        read = decodeRoutineInboxEntryV1(value).acknowledged;
      } catch {
        // An entry nothing can decode says nothing to anyone; it is the first
        // thing worth reclaiming space from.
        read = true;
      }
      (read ? acknowledged : unread).push(key);
    }
    for (const key of [...acknowledged, ...unread]) {
      if (excess <= 0) return;
      await this.#storage.delete(key);
      excess -= 1;
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
