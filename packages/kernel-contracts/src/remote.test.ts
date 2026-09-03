import { describe, expect, test } from "bun:test";
import {
  RemoteCallTimeoutError,
  remoteCallV1,
  retryOnceV1,
  withDeadlineV1,
} from "./remote.js";

describe("a remote call is bounded", () => {
  test("a call that never answers is abandoned, not waited on", async () => {
    const signals: AbortSignal[] = [];
    const call = await withDeadlineV1(
      "the ledger",
      (signal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      },
      10,
    ).catch((error: unknown) => error);

    expect(call).toBeInstanceOf(RemoteCallTimeoutError);
    expect((call as Error).message).toContain("the ledger");
    // The binding is told, even though the deadline is a bound on waiting and
    // not a guarantee that the effect did not land.
    expect(signals[0]!.aborted).toBe(true);
  });

  test("an answer inside the deadline is returned unchanged", async () => {
    expect(await withDeadlineV1("the ledger", () => Promise.resolve(7), 1_000))
      .toBe(7);
  });

  test("a transient failure is tried once more, and only once", async () => {
    let attempts = 0;
    expect(
      await retryOnceV1(() => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("blip"))
          : Promise.resolve("second");
      }),
    ).toBe("second");
    expect(attempts).toBe(2);

    let always = 0;
    await expect(
      retryOnceV1(() => {
        always += 1;
        return Promise.reject(new Error("really down"));
      }),
    ).rejects.toThrow("really down");
    expect(always).toBe(2);
  });

  test("a hung call is retried under its own fresh deadline", async () => {
    let attempts = 0;
    await expect(
      remoteCallV1(
        "the memory index",
        () => {
          attempts += 1;
          return new Promise<never>(() => {});
        },
        10,
      ),
    ).rejects.toBeInstanceOf(RemoteCallTimeoutError);
    expect(attempts).toBe(2);
  });
});
