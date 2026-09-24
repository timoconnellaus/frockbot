// A compaction that outlives the Turn, keeps running past the next admission,
// and never writes beside it.
import { describe, expect, test } from "bun:test";
import type { Session } from "@frockbot/core/contracts";
import {
  admitTurnToSessionLogV1,
  compactionInFlightV1,
  compactionWorkV1,
  whenCompactionSettledV1,
} from "./compaction-scheduler.js";

/** A promise and the function that settles it, for ordering without timers. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Stands in for a Turn's Session; the scheduler only hands it back. */
function sessionNamed(name: string): Session {
  return { id: name } as unknown as Session;
}

describe("detached compaction", () => {
  test("starting it does not wait for it", async () => {
    const session = `session-${crypto.randomUUID()}`;
    let finished = false;
    const release = gate();
    const started = Date.now();
    compactionWorkV1(session).start(async () => {
      await release.promise;
      finished = true;
    });
    // The claim the defect got wrong: control is back immediately.
    expect(Date.now() - started).toBeLessThan(50);
    expect(finished).toBe(false);
    expect(compactionInFlightV1(session)).toBe(true);
    release.open();
    await whenCompactionSettledV1(session);
    expect(finished).toBe(true);
  });

  test("a newly admitted Turn leaves the summariser running", async () => {
    const session = `session-${crypto.randomUUID()}`;
    const release = gate();
    let finished = false;
    compactionWorkV1(session).start(async () => {
      await release.promise;
      finished = true;
    });
    // Admission returns at once: the summariser is not aborted, and nothing
    // is waited for but a write under way.
    await admitTurnToSessionLogV1(session);
    expect(compactionInFlightV1(session)).toBe(true);
    release.open();
    await whenCompactionSettledV1(session);
    expect(finished).toBe(true);
  });

  test("writes through the last Turn's Session until a Turn is admitted", async () => {
    const session = `session-${crypto.randomUUID()}`;
    const work = compactionWorkV1(session);
    const writers: string[] = [];
    const write = () =>
      work.write(async (owner) => {
        writers.push(owner.id);
      });

    // Before any Turn has ended there is no owner to write through.
    expect(await write()).toBe(false);
    work.adopt(sessionNamed("turn-1"));
    expect(await write()).toBe(true);
    // A Turn takes the log: nothing is written beside it.
    await admitTurnToSessionLogV1(session);
    expect(await write()).toBe(false);
    // That Turn ends and owns the log in turn.
    work.adopt(sessionNamed("turn-2"));
    expect(await write()).toBe(true);
    expect(writers).toEqual(["turn-1", "turn-2"]);
  });

  test("an admission waits out a write already under way, and only that", async () => {
    const session = `session-${crypto.randomUUID()}`;
    const work = compactionWorkV1(session);
    work.adopt(sessionNamed("turn-1"));
    const flushing = gate();
    const order: string[] = [];
    const writing = work.write(async () => {
      await flushing.promise;
      order.push("write");
    });
    const admitted = admitTurnToSessionLogV1(session).then(() => {
      order.push("admitted");
    });
    flushing.open();
    await Promise.all([writing, admitted]);
    expect(order).toEqual(["write", "admitted"]);
  });

  test("a failure is nobody's problem, and never leaves work in flight", async () => {
    const session = `session-${crypto.randomUUID()}`;
    compactionWorkV1(session).start(async () => {
      throw new Error("the summariser fell over");
    });
    await whenCompactionSettledV1(session);
    expect(compactionInFlightV1(session)).toBe(false);
  });

  test("two compactions on one conversation never run beside each other", async () => {
    const session = `session-${crypto.randomUUID()}`;
    const order: string[] = [];
    const release = gate();
    compactionWorkV1(session).start(async () => {
      order.push("first:start");
      await release.promise;
      order.push("first:end");
    });
    compactionWorkV1(session).start(async () => {
      order.push("second:start");
    });
    expect(compactionInFlightV1(session)).toBe(true);
    release.open();
    await whenCompactionSettledV1(session);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(compactionInFlightV1(session)).toBe(false);
  });

  test("admission costs nothing when no compaction is running", async () => {
    await expect(
      admitTurnToSessionLogV1(`session-${crypto.randomUUID()}`),
    ).resolves.toBeUndefined();
  });
});
