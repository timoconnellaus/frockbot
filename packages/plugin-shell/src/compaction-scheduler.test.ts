// A compaction that outlives the Turn, and yields to the next one (ADR 0030).
import { describe, expect, test } from "bun:test";
import {
  compactionInFlightV1,
  compactionWorkV1,
  whenCompactionSettledV1,
  yieldCompactionWorkV1,
} from "./compaction-scheduler.js";

function stall(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** A promise and the function that settles it, for ordering without timers. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("detached compaction", () => {
  test("starting it does not wait for it", async () => {
    const session = `session-${crypto.randomUUID()}`;
    let finished = false;
    const running = gate();
    const started = Date.now();
    compactionWorkV1(session).start(async (signal) => {
      running.open();
      await stall(signal).catch(() => {});
      finished = true;
    });
    // The claim the defect got wrong: control is back immediately.
    expect(Date.now() - started).toBeLessThan(50);
    expect(finished).toBe(false);
    expect(compactionInFlightV1(session)).toBe(true);
    await running.promise;
    await yieldCompactionWorkV1(session);
    expect(finished).toBe(true);
  });

  test("a newly admitted Turn aborts it rather than queueing behind it", async () => {
    const session = `session-${crypto.randomUUID()}`;
    let reason: unknown;
    const running = gate();
    compactionWorkV1(session).start(async (signal) => {
      running.open();
      try {
        await stall(signal);
      } catch (error) {
        reason = error;
      }
    });
    await running.promise;
    await yieldCompactionWorkV1(session);
    expect(compactionInFlightV1(session)).toBe(false);
    expect(String((reason as Error).message)).toContain("yielded");
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
    release.open();
    await whenCompactionSettledV1(session);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("yielding costs nothing when no compaction is running", async () => {
    await expect(
      yieldCompactionWorkV1(`session-${crypto.randomUUID()}`),
    ).resolves.toBeUndefined();
  });
});
