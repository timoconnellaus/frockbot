import { describe, expect, test } from "bun:test";
import { withDeadlineV1 } from "./deadline.ts";

describe("withDeadlineV1", () => {
  test("aborts when the deadline passes, and says it was the deadline", async () => {
    const deadline = withDeadlineV1(5);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
  });

  test("a cleared deadline never aborts", async () => {
    const deadline = withDeadlineV1(5);
    deadline.clear();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
  });

  test("clear is idempotent, and safe once the deadline has passed", async () => {
    const deadline = withDeadlineV1(5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    deadline.clear();
    deadline.clear();
    expect(deadline.timedOut()).toBe(true);
  });

  test("the caller's own signal still aborts, and is not reported as a timeout", () => {
    const caller = new AbortController();
    const deadline = withDeadlineV1(60_000, caller.signal);
    caller.abort();
    expect(deadline.signal.aborted).toBe(true);
    // The provider answered nothing because the caller left, which is not the
    // provider failing to answer in time.
    expect(deadline.timedOut()).toBe(false);
    deadline.clear();
  });
});
