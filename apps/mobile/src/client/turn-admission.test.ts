import { describe, expect, test } from "bun:test";
import type { TurnResponse } from "./transport.ts";
import { admitMobileTurn } from "./turn-admission.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const completedTurn: TurnResponse = {
  runId: "command-1",
  text: "done",
  events: [],
};

describe("mobile Turn admission", () => {
  test("does not claim acceptance when a Bot switch wins before dispatch", async () => {
    const preparation = deferred<void>();
    let current = true;
    let requests = 0;
    let reconciliations = 0;
    const admission = admitMobileTurn({
      commandId: "command-1",
      prepare: () => preparation.promise,
      isCurrent: () => current,
      request: () => {
        requests += 1;
        return Promise.resolve(completedTurn);
      },
      reconcile: () => {
        reconciliations += 1;
        return Promise.resolve(completedTurn);
      },
    });

    current = false;
    preparation.resolve();

    expect(await admission).toEqual({
      status: "not-started",
      commandId: "command-1",
    });
    expect(requests).toBe(0);
    expect(reconciliations).toBe(0);
  });

  test("retains the command id and reconciles an aborted dispatch", async () => {
    const dispatched = deferred<TurnResponse>();
    const reconciled = deferred<TurnResponse>();
    let current = true;
    const commandIds: string[] = [];
    const admissionPromise = admitMobileTurn({
      commandId: "command-1",
      prepare: () => Promise.resolve(),
      isCurrent: () => current,
      request: () => {
        commandIds.push("command-1");
        return dispatched.promise;
      },
      reconcile: () => {
        commandIds.push("command-1");
        return reconciled.promise;
      },
    });

    await Promise.resolve();
    current = false;
    dispatched.reject(new DOMException("aborted", "AbortError"));
    const admission = await admissionPromise;

    expect(admission).toMatchObject({
      status: "uncertain",
      commandId: "command-1",
    });
    expect(commandIds).toEqual(["command-1", "command-1"]);
    if (admission.status !== "uncertain") throw new Error("expected retry");
    reconciled.resolve(completedTurn);
    expect(await admission.reconciliation).toEqual(completedTurn);
  });

  test("reports acceptance only after decoding a backend response", async () => {
    const admission = await admitMobileTurn({
      commandId: "command-1",
      prepare: () => Promise.resolve(),
      isCurrent: () => true,
      request: () => Promise.resolve(completedTurn),
      reconcile: () => Promise.reject(new Error("must not reconcile")),
    });

    expect(admission).toEqual({
      status: "confirmed",
      commandId: "command-1",
      response: completedTurn,
    });
  });
});
