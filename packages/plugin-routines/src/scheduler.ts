// The scheduler: the half of a Routine that makes it fire.
//
// It owns no alarm of its own. "The Bot's Durable Object is the authority for
// … durable scheduling", and that authority is one `alarm()` with three
// Package-supplied hooks. This class is what the Shell composes into them:
//
//   deadlines(tx)  → the moments a Routine wants the object woken
//   defer(tx)      → the object is busy; hold, but keep the debt
//   settle(fire)   → nothing is executing; drain what is owed
//
// Three rules are enforced here and nowhere else.
//
//  * **A deferral never moves `dueAt`.** Pushing the due time forward while a
//    Turn runs would silently skip the firing. The hold is a separate field, so
//    when the object frees up the debt is still there and the firing lands.
//  * **One unsettled firing per Routine.** `routine-fire:<id>` is written
//    before the Turn is admitted and deleted when it settles, so it is both the
//    durable intent and the lock. A firing owed while one is unsettled queues
//    behind it, bounded; it is never run in parallel and never dropped in
//    silence.
//  * **Lateness coalesces, it never backfills.** A Routine the object slept
//    through fires once, records how many occurrences that covered, and
//    recomputes forward from now.
import {
  missedRoutineRunsV1,
  nextRoutineRunV1,
  normalizeRoutineScheduleV1,
  type NormalizedScheduleV1,
} from "./cron.js";
import {
  decodeRoutineFireV1,
  decodeRoutineScheduleStateV1,
  routineCueV1,
  routineFireIdV1,
  type RoutineFireV1,
  type RoutineScheduleStateV1,
} from "./firing.js";
import {
  decodeRoutineRecordV1,
  type RoutineRecordV1,
  type RoutineRunEntryV1,
  type RoutineRunStatusV1,
  type RoutineTriggerKindV1,
} from "./records.js";
import {
  appendRoutineRunEntryV1,
  type RoutineStorageV1,
  type RoutineStorageWritesV1,
} from "./store.js";
import {
  nextQueueSequenceV1,
  ROUTINE_DEFERRAL_MS,
  ROUTINE_LIMIT_PER_BOT,
  ROUTINE_MISSED_GRACE_MS,
  ROUTINE_PREFIX,
  ROUTINE_QUEUE_LIMIT,
  ROUTINE_QUEUE_PREFIX,
  routineFireKeyV1,
  routineKeyV1,
  routineQueueKeyV1,
  routineQueuePrefixV1,
  routineScheduleKeyV1,
} from "./storage-keys.js";

/** How many firings one `settle` drains before it hands the object back. */
export const ROUTINE_SETTLE_BATCH = 8;

/** What running one firing produced. The scheduler never decides this itself. */
export interface RoutineFireOutcomeV1 {
  status: Extract<RoutineRunStatusV1, "ok" | "failed" | "cancelled">;
  summary?: string;
}

/**
 * The seam that actually admits the Turn. The Shell supplies it, because only
 * the Durable Object holds `authority.run` — and `authority.run` is a direct
 * method call, so no HTTP path can reach a Routine firing.
 */
export type RoutineFireExecutorV1 = (
  fire: RoutineFireV1,
) => Promise<RoutineFireOutcomeV1>;

export interface RoutineSchedulerOptionsV1 {
  now?(): Date;
  /** Injected so a test can watch the drain without a Durable Object. */
  onSettled?(fire: RoutineFireV1, outcome: RoutineFireOutcomeV1): void;
}

/** A firing waiting behind an unsettled one. */
interface QueuedFiringV1 {
  schemaVersion: 1;
  trigger: RoutineTriggerKindV1;
  discriminator: string;
  requestedAt: string;
  delivery?: string;
}

function queued(value: unknown): QueuedFiringV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.trigger !== "string" ||
    typeof candidate.discriminator !== "string" ||
    typeof candidate.requestedAt !== "string"
  ) {
    return undefined;
  }
  return candidate as unknown as QueuedFiringV1;
}

/**
 * A Routine's clock, computed if it has never been written or if the Routine's
 * timing has been rewritten since it was.
 *
 * The anchor is the record's `updatedAt`: editing a schedule is a new anchor, so
 * `@every 15m` restarts from the edit rather than inheriting a due time the old
 * schedule chose.
 */
export function routineScheduleStateV1(
  record: RoutineRecordV1,
  stored: RoutineScheduleStateV1 | undefined,
  normalized: NormalizedScheduleV1,
): RoutineScheduleStateV1 {
  if (stored && stored.anchor === record.updatedAt) return stored;
  const anchor = new Date(record.updatedAt);
  const next = nextRoutineRunV1(normalized, anchor, anchor);
  return {
    schemaVersion: 1,
    routineId: record.routineId,
    anchor: record.updatedAt,
    dueAt: (next ?? anchor).getTime(),
  };
}

/**
 * When the alarm must next consider this Routine.
 *
 * A hold wins while it lasts, and expires on its own: the deadline is the later
 * of the debt and the hold. Taking the earlier one would arm an alarm on a due
 * time already in the past for as long as the object stayed busy, which is a
 * spin rather than a deferral.
 */
export function routineDeadlineV1(state: RoutineScheduleStateV1): number {
  return state.deferredUntil === undefined
    ? state.dueAt
    : Math.max(state.dueAt, state.deferredUntil);
}

interface ClaimedFiringV1 {
  fire: RoutineFireV1;
  record: RoutineRecordV1;
}

export class RoutineScheduler {
  readonly #storage: RoutineStorageV1;
  readonly #now: () => Date;
  readonly #onSettled:
    ((fire: RoutineFireV1, outcome: RoutineFireOutcomeV1) => void) | undefined;

  constructor(
    storage: RoutineStorageV1,
    options: RoutineSchedulerOptionsV1 = {},
  ) {
    this.#storage = storage;
    this.#now = options.now ?? (() => new Date());
    this.#onSettled = options.onSettled;
  }

  /**
   * Every moment a Routine wants the object woken, for the kernel's single
   * alarm to take the minimum of alongside the Shell's saga deadlines.
   */
  async deadlines(reads: RoutineStorageWritesV1): Promise<number[]> {
    const deadlines: number[] = [];
    for (const { record, state } of await this.#clocks(reads)) {
      // A Routine with an unsettled firing is already being dealt with, and one
      // with a queue wants the object as soon as that firing settles.
      const locked = await reads.get<unknown>(
        routineFireKeyV1(record.routineId),
      );
      if (locked) continue;
      deadlines.push(routineDeadlineV1(state));
    }
    for (const routineId of await this.#queuedRoutineIds(reads)) {
      if (await reads.get<unknown>(routineFireKeyV1(routineId))) continue;
      deadlines.push(this.#now().getTime());
    }
    return deadlines;
  }

  /**
   * The object is busy. Hold every Routine off for a short interval and leave
   * `dueAt` exactly where it is, so the debt survives the Turn that displaced
   * it.
   */
  async defer(writes: RoutineStorageWritesV1): Promise<void> {
    const deferredUntil = this.#now().getTime() + ROUTINE_DEFERRAL_MS;
    for (const { record, state } of await this.#clocks(writes)) {
      await writes.put(routineScheduleKeyV1(record.routineId), {
        ...state,
        deferredUntil,
      } satisfies RoutineScheduleStateV1);
    }
  }

  /**
   * Nothing is executing. Drain what is owed, one firing at a time: mint the
   * durable firing, run it, settle it, then look again.
   */
  async settle(execute: RoutineFireExecutorV1): Promise<void> {
    for (let drained = 0; drained < ROUTINE_SETTLE_BATCH; drained += 1) {
      const claimed = await this.#claim();
      if (!claimed) return;
      let outcome: RoutineFireOutcomeV1;
      try {
        outcome = await execute(claimed.fire);
      } catch (error) {
        outcome = {
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
        };
      }
      await this.#settleFiring(claimed.fire, outcome);
      this.#onSettled?.(claimed.fire, outcome);
    }
  }

  /**
   * Ask for a firing now, outside the clock: `run_now`, or a delivered webhook.
   *
   * It is enqueued rather than run, because the caller may itself be a Turn in
   * flight and "queue, never drop, never parallel" holds for a manual firing
   * exactly as it does for a scheduled one. The alarm drains it.
   */
  async enqueue(input: {
    routineId: string;
    trigger: RoutineTriggerKindV1;
    discriminator: string;
    delivery?: string;
  }): Promise<{ fireId: string; queued: boolean }> {
    return this.#storage.transaction((transaction) =>
      this.enqueueWithin(transaction, input),
    );
  }

  /**
   * The same request, inside a transaction the caller already holds — the
   * `routine/run` command path, which writes its durable receipt in the same
   * transaction so a replayed command id enqueues nothing a second time.
   */
  async enqueueWithin(
    transaction: RoutineStorageWritesV1,
    input: {
      routineId: string;
      trigger: RoutineTriggerKindV1;
      discriminator: string;
      delivery?: string;
    },
  ): Promise<{ fireId: string; queued: boolean }> {
    const fireId = routineFireIdV1(input.routineId, input.discriminator);
    const existing = await transaction.get<unknown>(
      routineFireKeyV1(input.routineId),
    );
    if (existing && decodeRoutineFireV1(existing).fireId === fireId) {
      // The same firing, asked for twice. One firing.
      return { fireId, queued: false };
    }
    const waiting = await transaction.list<unknown>({
      prefix: routineQueuePrefixV1(input.routineId),
    });
    for (const value of waiting.values()) {
      if (queued(value)?.discriminator === input.discriminator) {
        return { fireId, queued: false };
      }
    }
    if (waiting.size >= ROUTINE_QUEUE_LIMIT) {
      throw new Error(
        `Routine "${input.routineId}" already has ${ROUTINE_QUEUE_LIMIT} firings waiting`,
      );
    }
    await transaction.put(
      routineQueueKeyV1(
        input.routineId,
        nextQueueSequenceV1([...waiting.keys()]),
      ),
      {
        schemaVersion: 1,
        trigger: input.trigger,
        discriminator: input.discriminator,
        requestedAt: this.#now().toISOString(),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      } satisfies QueuedFiringV1,
    );
    return { fireId, queued: true };
  }

  /** The unsettled firing of one Routine, if it has one. */
  async readFire(routineId: string): Promise<RoutineFireV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      routineFireKeyV1(routineId),
    );
    return stored === undefined ? undefined : decodeRoutineFireV1(stored);
  }

  /** When each scheduled Routine is next owed a firing, for the "next run" row. */
  async nextRuns(): Promise<Map<string, string>> {
    const next = new Map<string, string>();
    for (const { record, state } of await this.#clocks(this.#storage)) {
      next.set(record.routineId, new Date(state.dueAt).toISOString());
    }
    return next;
  }

  /** Every enabled scheduled Routine with the clock it is read under. */
  async #clocks(
    reads: RoutineStorageWritesV1,
  ): Promise<
    Array<{ record: RoutineRecordV1; state: RoutineScheduleStateV1 }>
  > {
    const stored = await reads.list<unknown>({
      prefix: ROUTINE_PREFIX,
      limit: ROUTINE_LIMIT_PER_BOT,
    });
    const clocks: Array<{
      record: RoutineRecordV1;
      state: RoutineScheduleStateV1;
    }> = [];
    for (const value of stored.values()) {
      const record = decodeRoutineRecordV1(value);
      if (!record.enabled || record.schedule === undefined) continue;
      const normalized = normalizeRoutineScheduleV1(
        record.schedule,
        record.timezone,
      );
      const persisted = await reads.get<unknown>(
        routineScheduleKeyV1(record.routineId),
      );
      clocks.push({
        record,
        state: routineScheduleStateV1(
          record,
          persisted === undefined
            ? undefined
            : decodeRoutineScheduleStateV1(persisted),
          normalized,
        ),
      });
    }
    return clocks;
  }

  async #queuedRoutineIds(reads: RoutineStorageWritesV1): Promise<string[]> {
    const waiting = await reads.list<unknown>({ prefix: ROUTINE_QUEUE_PREFIX });
    const ids = new Set<string>();
    for (const key of waiting.keys()) {
      const rest = key.slice(ROUTINE_QUEUE_PREFIX.length);
      const separator = rest.lastIndexOf(":");
      if (separator > 0) ids.add(rest.slice(0, separator));
    }
    return [...ids];
  }

  /**
   * Mint the next firing that is owed, durably, before anything runs it.
   *
   * Everything the firing needs to be reconstructed after an eviction is
   * written in this one transaction: the firing itself, the advanced clock, the
   * `running` run-log entry, and the Routine's `lastRunAt`.
   */
  async #claim(): Promise<ClaimedFiringV1 | undefined> {
    const now = this.#now();
    return this.#storage.transaction<ClaimedFiringV1 | undefined>(
      async (transaction) => {
        // A queued firing outranks the clock: it was already owed.
        for (const routineId of await this.#queuedRoutineIds(transaction)) {
          if (await transaction.get<unknown>(routineFireKeyV1(routineId))) {
            continue;
          }
          const claimed = await this.#claimQueued(transaction, routineId, now);
          if (claimed) return claimed;
        }
        for (const { record, state } of await this.#clocks(transaction)) {
          if (
            await transaction.get<unknown>(routineFireKeyV1(record.routineId))
          ) {
            // Locked. The debt is preserved on the clock; queueing it here
            // would double-count, because the clock has not advanced.
            continue;
          }
          if (routineDeadlineV1(state) > now.getTime()) continue;
          return this.#claimScheduled(transaction, record, state, now);
        }
        return undefined;
      },
    );
  }

  async #claimQueued(
    transaction: RoutineStorageWritesV1,
    routineId: string,
    now: Date,
  ): Promise<ClaimedFiringV1 | undefined> {
    const waiting = await transaction.list<unknown>({
      prefix: routineQueuePrefixV1(routineId),
    });
    const first = [...waiting.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )[0];
    if (!first) return undefined;
    await transaction.delete(first[0]);
    const request = queued(first[1]);
    const stored = await transaction.get<unknown>(routineKeyV1(routineId));
    if (!request || stored === undefined) {
      // The Routine was deleted under a waiting firing. Drop the request; the
      // record it would have run is gone, and a firing needs one.
      return undefined;
    }
    const record = decodeRoutineRecordV1(stored);
    const fire: RoutineFireV1 = {
      schemaVersion: 1,
      routineId,
      fireId: routineFireIdV1(routineId, request.discriminator),
      trigger: request.trigger,
      cue: routineCueV1({
        name: record.name,
        prompt: record.prompt,
        trigger: request.trigger,
        ...(request.delivery === undefined
          ? {}
          : { delivery: request.delivery }),
      }),
      mintedAt: now.toISOString(),
      entryId: `${routineFireIdV1(routineId, request.discriminator)}-entry`,
    };
    await this.#writeClaim(transaction, record, fire, now);
    return { fire, record };
  }

  async #claimScheduled(
    transaction: RoutineStorageWritesV1,
    record: RoutineRecordV1,
    state: RoutineScheduleStateV1,
    now: Date,
  ): Promise<ClaimedFiringV1> {
    const normalized = normalizeRoutineScheduleV1(
      record.schedule!,
      record.timezone,
    );
    const anchor = new Date(record.updatedAt);
    const late = now.getTime() - state.dueAt > ROUTINE_MISSED_GRACE_MS;
    const missedCount = late
      ? missedRoutineRunsV1(normalized, new Date(state.dueAt), now, anchor)
      : 1;
    const fire: RoutineFireV1 = {
      schemaVersion: 1,
      routineId: record.routineId,
      fireId: routineFireIdV1(record.routineId, String(state.dueAt)),
      trigger: "cron",
      cue: routineCueV1({
        name: record.name,
        prompt: record.prompt,
        trigger: "cron",
        ...(missedCount > 1 ? { missedCount } : {}),
      }),
      mintedAt: now.toISOString(),
      dueAt: state.dueAt,
      ...(missedCount > 1 ? { missedCount } : {}),
      entryId: `${routineFireIdV1(record.routineId, String(state.dueAt))}-entry`,
    };
    // Recompute forward from now when the firing was late, and from the
    // occurrence itself when it was on time; either way the clock advances
    // before the Turn runs, so a crash mid-Turn cannot re-owe this occurrence.
    const from = late ? now : new Date(state.dueAt);
    const next = nextRoutineRunV1(normalized, from, anchor);
    await transaction.put(routineScheduleKeyV1(record.routineId), {
      schemaVersion: 1,
      routineId: record.routineId,
      anchor: record.updatedAt,
      dueAt: (
        next ?? new Date(now.getTime() + ROUTINE_MISSED_GRACE_MS)
      ).getTime(),
    } satisfies RoutineScheduleStateV1);
    if (missedCount > 1) {
      // One entry says what was slept through. It is `skipped`, not `ok`: the
      // occurrences it names never ran and the log must not imply they did.
      await appendRoutineRunEntryV1(transaction, {
        schemaVersion: 1,
        entryId: `${fire.entryId}-missed`,
        routineId: record.routineId,
        runId: fire.fireId,
        fireId: fire.fireId,
        trigger: "cron",
        status: "skipped",
        startedAt: new Date(state.dueAt).toISOString(),
        finishedAt: now.toISOString(),
        summary: `${missedCount - 1} scheduled occurrences elapsed while the Routine was not fired; this firing covers them.`,
      } satisfies RoutineRunEntryV1);
    }
    await this.#writeClaim(transaction, record, fire, now);
    return { fire, record };
  }

  async #writeClaim(
    transaction: RoutineStorageWritesV1,
    record: RoutineRecordV1,
    fire: RoutineFireV1,
    now: Date,
  ): Promise<void> {
    await transaction.put(routineFireKeyV1(record.routineId), fire);
    await appendRoutineRunEntryV1(transaction, {
      schemaVersion: 1,
      entryId: fire.entryId,
      routineId: record.routineId,
      runId: fire.fireId,
      fireId: fire.fireId,
      trigger: fire.trigger,
      status: "running",
      startedAt: now.toISOString(),
    } satisfies RoutineRunEntryV1);
    await transaction.put(routineKeyV1(record.routineId), {
      ...record,
      lastRunAt: now.toISOString(),
    } satisfies RoutineRecordV1);
  }

  async #settleFiring(
    fire: RoutineFireV1,
    outcome: RoutineFireOutcomeV1,
  ): Promise<void> {
    const finishedAt = this.#now().toISOString();
    await this.#storage.transaction(async (transaction) => {
      await transaction.delete(routineFireKeyV1(fire.routineId));
      const startedAt = fire.mintedAt;
      await appendRoutineRunEntryV1(transaction, {
        schemaVersion: 1,
        entryId: fire.entryId,
        routineId: fire.routineId,
        runId: fire.fireId,
        fireId: fire.fireId,
        trigger: fire.trigger,
        status: outcome.status,
        startedAt,
        finishedAt,
        ...(outcome.summary === undefined
          ? {}
          : { summary: outcome.summary.slice(0, 2_000) }),
      } satisfies RoutineRunEntryV1);
    });
  }
}
