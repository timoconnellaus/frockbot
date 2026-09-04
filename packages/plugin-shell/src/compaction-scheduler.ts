// Where a compaction actually runs, now that it no longer runs in the Turn.
//
// ADR 0030 always meant the summariser to cost a person nothing: it is
// evaluated at Turn end, after `turn/end` is journaled, precisely so the Turn
// they were waiting on is already over. The Turn-end hook honoured the *order*
// and not the *waiting*: `agent/turn-stopping` is a serial hook the agent loop
// awaits inside `#runTurn`'s `finally`, so `whenIdle` — and therefore the run's
// terminal record, the `runs` broadcast, and the HTTP response — all sat behind
// a 40-second model call. The client stayed busy the whole time.
//
// So the summariser is detached from the Turn here. The hook hands the work to
// this scheduler and returns; the Turn ends, the run settles, the response goes
// out, and the compaction carries on afterwards on the Composition the Turn
// mounted, which is disposed when it finishes rather than when the Turn does.
//
// **It yields to admission.** The alternative — letting a compaction hold the
// next Turn behind it — is the very latency this removes, one message later. So
// the next admission aborts it and waits only for that abort to settle, which
// keeps every write to the session log serialised behind exactly one owner. An
// aborted compaction leaves an intent with no outcome, which is the case ADR
// 0028 already covers: the next Turn end settles it as a failure and backoff
// picks the range up again. Nothing is corrupted by losing one, and nobody
// waits for one.
//
// Keyed by session id and held for the lifetime of the isolate, because that is
// exactly the scope the work has: a Durable Object holds one conversation, and
// work detached from one Turn has to be findable from the next.

/** One conversation's detached compaction, at most one at a time. */
class CompactionWork {
  #controller: AbortController | undefined;
  #settled: Promise<void> = Promise.resolve();

  get inFlight(): boolean {
    return this.#controller !== undefined;
  }

  /**
   * Starts work that outlives the Turn. Returns as soon as the work has begun,
   * never when it has finished — that is the whole point.
   */
  start(run: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    const previous = this.#settled;
    this.#controller = controller;
    this.#settled = (async () => {
      // Serialised rather than concurrent: two compactions writing to one
      // session log is the one thing detaching them could get wrong.
      await previous;
      try {
        // Aborted before it ever began — a Turn was admitted in the same tick.
        if (!controller.signal.aborted) await run(controller.signal);
      } catch {
        // A compaction that fails is a conversation that carries on under ADR
        // 0027's eviction. There is nobody to tell.
      } finally {
        if (this.#controller === controller) this.#controller = undefined;
      }
    })();
  }

  /** Waits for the work without hurrying it. For tests and for shutdown. */
  whenSettled(): Promise<void> {
    return this.#settled;
  }

  /**
   * Hands the conversation back. Aborts anything in flight and waits for it to
   * finish unwinding, so the next Turn is never writing to the log beside it.
   */
  async yieldToTurn(): Promise<void> {
    this.#controller?.abort(
      new Error("A new Turn was admitted, so the compaction yielded to it."),
    );
    await this.#settled;
  }
}

const work = new Map<string, CompactionWork>();

/** The detached compaction for one conversation, created on first use. */
export function compactionWorkV1(sessionId: string): CompactionWork {
  const existing = work.get(sessionId);
  if (existing) return existing;
  const created = new CompactionWork();
  work.set(sessionId, created);
  return created;
}

/**
 * Called on the admission path, before a Turn reads the session log. Costs
 * nothing when no compaction is in flight, and an abort when one is.
 */
export async function yieldCompactionWorkV1(sessionId: string): Promise<void> {
  await work.get(sessionId)?.yieldToTurn();
}

/** Whether a conversation has a compaction still running. */
export function compactionInFlightV1(sessionId: string): boolean {
  return work.get(sessionId)?.inFlight ?? false;
}

/** Awaits a detached compaction without aborting it. Tests and shutdown only. */
export async function whenCompactionSettledV1(
  sessionId: string,
): Promise<void> {
  await work.get(sessionId)?.whenSettled();
}
