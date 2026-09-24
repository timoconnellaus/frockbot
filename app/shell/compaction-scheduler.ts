// Where a compaction actually runs, now that it no longer runs in the Turn.
//
// The summariser was always meant to cost a person nothing: it is evaluated at
// Turn end, after `turn/end` is journaled, precisely so the Turn they were
// waiting on is already over. The Turn-end hook honoured the *order* and not
// the *waiting*: `agent/turn-stopping` is a serial hook the agent loop awaits
// inside `#runTurn`'s `finally`, so `whenIdle` — and therefore the run's
// terminal record, the `runs` broadcast, and the HTTP response — all sat behind
// a 40-second model call. The client stayed busy the whole time.
//
// So the summariser is detached from the Turn here. The hook hands the work to
// this scheduler and returns; the Turn ends, the run settles, the response goes
// out, and the compaction carries on afterwards on the Composition the Turn
// mounted, which is disposed when it finishes rather than when the Turn does.
//
// **It keeps running when the next Turn is admitted, and never writes beside
// it.** A summary covers a fixed prefix of the conversation, so one that
// arrives while a later Turn runs is exactly as right as one that arrived
// before it; aborting it threw away paid work every time a person typed
// quickly. What admission must still guarantee is one writer on the session
// log — each Turn's Session numbers events from its own counter. So admission
// takes the log: the summariser runs on, and an outcome that arrives while a
// Turn holds the log, or after a later Turn has ended, is parked, then written
// by the next Turn end, before that Turn assesses anything. A run writes only
// through the Session of the Turn that started it, because that Turn's
// Composition is the one its summariser calls are checked against. A Turn therefore always starts from whatever summary
// had landed by the end of the Turn before it.
//
// Keyed by session id within the Durable Object instance that runs it, because
// that is exactly the scope the work has: work detached from one Turn has to be
// findable from the next, and nothing outlives the instance it ran in. An
// instance that is reset while the isolate lives on leaves its summariser bound
// to a dead actor, never settling; the next instance starts with no queue, and
// reconciliation settles the intent it left as interrupted.
import type { Session } from "@frockbot/core/contracts";
import type {
  ParkedCompactionStoreV1,
  ParkedCompactionV1,
} from "./compaction.js";

/** One conversation's detached compaction, at most one at a time. */
class CompactionWork {
  #running = 0;
  #settled: Promise<void> = Promise.resolve();
  /** Turns admitted since the isolate started; a Turn end records the count. */
  #admissions = 0;
  /** The Session of the last Turn to end, and whether a Turn came since. */
  #owner: { session: Session; admissions: number } | undefined;
  /** The log write in progress, which an admission waits out. */
  #writing: Promise<unknown> = Promise.resolve();
  #parked: ParkedCompactionV1 | undefined;

  get inFlight(): boolean {
    return this.#running > 0;
  }

  /**
   * Starts work that outlives the Turn. Returns as soon as the work has begun,
   * never when it has finished — that is the whole point.
   */
  start(run: () => Promise<unknown>): void {
    const previous = this.#settled;
    this.#running += 1;
    this.#settled = (async () => {
      // Serialised rather than concurrent: a second summary of the same
      // prefix would be paid for twice.
      await previous;
      try {
        await run();
      } catch {
        // A compaction that fails is a conversation that carries on under
        // oldest-first eviction. There is nobody to tell.
      } finally {
        this.#running -= 1;
      }
    })();
  }

  /** A Turn ended: its Session owns the log until the next admission. */
  adopt(session: Session): void {
    this.#owner = { session, admissions: this.#admissions };
  }

  /**
   * A Turn is being admitted and takes the log. The summariser keeps running;
   * only a write already under way is waited for, and that is milliseconds.
   */
  async admitTurn(): Promise<void> {
    this.#admissions += 1;
    await this.#writing;
  }

  /**
   * Writes through `session` if it is the Session of the last Turn to end and
   * no Turn has been admitted since. `false` means another Turn holds the log,
   * or has ended since and carries the work on through its own Composition.
   */
  async write(
    session: Session,
    append: (session: Session) => Promise<void>,
  ): Promise<boolean> {
    const owner = this.#owner;
    if (
      !owner ||
      owner.session !== session ||
      owner.admissions !== this.#admissions
    ) {
      return false;
    }
    // Checked and begun in one tick, so an admission that arrives now waits
    // for this write rather than racing it.
    const writing = append(session);
    this.#writing = writing.catch(() => {});
    await writing;
    return true;
  }

  /** Where an outcome waits when no durable store was provided. */
  readonly memoryParking: ParkedCompactionStoreV1 = {
    read: async () => this.#parked,
    write: async (outcome) => {
      this.#parked = outcome;
    },
    clear: async () => {
      this.#parked = undefined;
    },
  };

  /** Waits for the work without hurrying it. For tests and for shutdown. */
  whenSettled(): Promise<void> {
    return this.#settled;
  }
}

/** The scope of a runtime that is not a Durable Object instance. */
const isolateScope = {};
const work = new WeakMap<object, Map<string, CompactionWork>>();

/**
 * The Durable Object instance a Session's Turn ran in, as the Turn's working
 * context selector names it.
 */
export function compactionScopeV1(session: Session): object {
  return (
    (session.workingContextSelector as { compactionScope?: object } | undefined)
      ?.compactionScope ?? isolateScope
  );
}

/** The detached compaction for one conversation, created on first use. */
export function compactionWorkV1(
  sessionId: string,
  scope: object = isolateScope,
): CompactionWork {
  let scoped = work.get(scope);
  if (!scoped) {
    scoped = new Map();
    work.set(scope, scoped);
  }
  const existing = scoped.get(sessionId);
  if (existing) return existing;
  const created = new CompactionWork();
  scoped.set(sessionId, created);
  return created;
}

/**
 * Called on the admission path, before a Turn reads the session log. The
 * summariser is left running; any write it has under way finishes first.
 */
export async function admitTurnToSessionLogV1(
  sessionId: string,
  scope: object = isolateScope,
): Promise<void> {
  await compactionWorkV1(sessionId, scope).admitTurn();
}

/** Whether a conversation has a compaction still running. */
export function compactionInFlightV1(
  sessionId: string,
  scope: object = isolateScope,
): boolean {
  return work.get(scope)?.get(sessionId)?.inFlight ?? false;
}

/** Awaits a detached compaction. Tests and shutdown only. */
export async function whenCompactionSettledV1(
  sessionId: string,
  scope: object = isolateScope,
): Promise<void> {
  await work.get(scope)?.get(sessionId)?.whenSettled();
}
