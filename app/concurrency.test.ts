import { describe, expect, test } from "bun:test";
import {
  createConcurrencyLimiterV1,
  TURN_READ_CONCURRENCY_V1,
} from "./concurrency.ts";

/** Lets every already-queued continuation run before the test looks again. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A task that reports the high-water mark of tasks running beside it. */
function tracked() {
  let running = 0;
  let peak = 0;
  const settle: Array<() => void> = [];
  return {
    peak: () => peak,
    release: () => settle.shift()?.(),
    pending: () => settle.length,
    task:
      <T>(value: T) =>
      () => {
        running += 1;
        peak = Math.max(peak, running);
        return new Promise<T>((resolve) => {
          settle.push(() => {
            running -= 1;
            resolve(value);
          });
        });
      },
  };
}

describe("the turn-start read limiter", () => {
  test("keeps at most the bound in flight and preserves results in order", async () => {
    const work = tracked();
    const inFlight = createConcurrencyLimiterV1(3);
    const values = [...Array(10).keys()];

    const all = Promise.all(values.map((value) => inFlight(work.task(value))));
    // Drain one at a time; each completion may admit exactly one more.
    for (let done = 0; done < values.length; done += 1) {
      await tick();
      work.release();
    }

    expect(await all).toEqual(values);
    expect(work.peak()).toBe(3);
  });

  test("runs everything handed to it, in parallel up to the bound", async () => {
    const work = tracked();
    const inFlight = createConcurrencyLimiterV1(4);
    const all = Promise.all(
      [...Array(4).keys()].map((n) => inFlight(work.task(n))),
    );

    // All four start together rather than one after another.
    await tick();
    expect(work.pending()).toBe(4);
    for (let done = 0; done < 4; done += 1) work.release();

    expect(await all).toEqual([0, 1, 2, 3]);
  });

  test("a failed task frees its slot and surfaces to its own caller", async () => {
    const inFlight = createConcurrencyLimiterV1(1);
    const failure = inFlight(() => Promise.reject(new Error("read refused")));

    expect(failure).rejects.toThrow("read refused");
    await expect(inFlight(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  test("defaults to the shared turn-start bound", async () => {
    const work = tracked();
    const inFlight = createConcurrencyLimiterV1();
    const all = Promise.all(
      [...Array(TURN_READ_CONCURRENCY_V1 + 5).keys()].map((n) =>
        inFlight(work.task(n)),
      ),
    );

    await tick();
    expect(work.pending()).toBe(TURN_READ_CONCURRENCY_V1);
    for (let done = 0; done < TURN_READ_CONCURRENCY_V1 + 5; done += 1) {
      await tick();
      work.release();
    }
    await all;
    expect(work.peak()).toBe(TURN_READ_CONCURRENCY_V1);
  });
});
