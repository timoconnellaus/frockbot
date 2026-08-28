import { describe, expect, test } from "bun:test";
import type { TurnResponse } from "./transport.ts";
import type { MobileBotProjectionState } from "./bot-projection.ts";
import {
  admitMobileTurn,
  projectMobileTurnAdmissionLookup,
  reconcileMobileTurnAdmission,
} from "./turn-admission.ts";

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
    const admission = admitMobileTurn({
      commandId: "command-1",
      prepare: () => preparation.promise,
      isCurrent: () => current,
      request: () => {
        requests += 1;
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
  });

  test("retains the command id without replaying an aborted dispatch", async () => {
    const dispatched = deferred<TurnResponse>();
    let current = true;
    let requests = 0;
    const admissionPromise = admitMobileTurn({
      commandId: "command-1",
      prepare: () => Promise.resolve(),
      isCurrent: () => current,
      request: () => {
        requests += 1;
        return dispatched.promise;
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
    expect(requests).toBe(1);
  });

  test("reports acceptance only after decoding a backend response", async () => {
    const admission = await admitMobileTurn({
      commandId: "command-1",
      prepare: () => Promise.resolve(),
      isCurrent: () => true,
      request: () => Promise.resolve(completedTurn),
    });

    expect(admission).toEqual({
      status: "confirmed",
      commandId: "command-1",
      response: completedTurn,
    });
  });

  test("observes a lost response from running through terminal state", async () => {
    const running = {
      state: "running" as const,
      run: {
        runId: "command-1",
        admittedAt: "2026-08-29T00:00:00.000Z",
        input: "continue",
        status: "running" as const,
        events: [],
      },
    };
    const terminal = {
      state: "terminal" as const,
      run: {
        ...running.run,
        status: "completed" as const,
        responseText: "done",
      },
    };
    const lookups = [running, terminal];
    const observations: string[] = [];
    const waits: number[] = [];

    const result = await reconcileMobileTurnAdmission({
      lookup: () => Promise.resolve(lookups.shift()!),
      observe: (lookup) => observations.push(lookup.state),
      transientFailure: () => {
        throw new Error("lookup must not fail");
      },
      wait: (delay) => {
        waits.push(delay);
        return Promise.resolve();
      },
      initialDelayMs: 10,
      maximumDelayMs: 20,
    });

    expect(result).toEqual(terminal);
    expect(observations).toEqual(["running", "terminal"]);
    expect(waits).toEqual([10]);
  });

  test("retries transient reads with bounded backoff", async () => {
    const terminal = {
      state: "terminal" as const,
      run: {
        runId: "command-1",
        admittedAt: "2026-08-29T00:00:00.000Z",
        input: "continue",
        status: "failed" as const,
        events: [],
        failure: "failed durably",
      },
    };
    let attempts = 0;
    const failures: string[] = [];
    const waits: number[] = [];

    const result = await reconcileMobileTurnAdmission({
      lookup: () => {
        attempts += 1;
        return attempts < 4
          ? Promise.reject(new Error(`temporary-${attempts}`))
          : Promise.resolve(terminal);
      },
      observe: () => undefined,
      transientFailure: (error) =>
        failures.push(error instanceof Error ? error.message : "unknown"),
      wait: (delay) => {
        waits.push(delay);
        return Promise.resolve();
      },
      initialDelayMs: 10,
      maximumDelayMs: 20,
    });

    expect(result).toEqual(terminal);
    expect(failures).toEqual(["temporary-1", "temporary-2", "temporary-3"]);
    expect(waits).toEqual([10, 20, 20]);
  });

  test("requires repeated read-only confirmation of non-admission", async () => {
    let attempts = 0;
    const observations: string[] = [];

    const result = await reconcileMobileTurnAdmission({
      lookup: () => {
        attempts += 1;
        return Promise.resolve({ state: "not-admitted" });
      },
      observe: (lookup) => observations.push(lookup.state),
      transientFailure: () => undefined,
      wait: () => Promise.resolve(),
      notAdmittedConfirmations: 3,
    });

    expect(result).toEqual({ state: "not-admitted" });
    expect(attempts).toBe(3);
    expect(observations).toEqual(["not-admitted"]);
  });

  test("keeps busy state until lookup is terminal or definitively absent", () => {
    const pendingMessages: MobileBotProjectionState["messages"] = [
      {
        id: "user",
        runId: "command-1",
        role: "user",
        text: "continue",
        status: "completed",
        tools: [],
      },
      {
        id: "assistant",
        runId: "command-1",
        role: "assistant",
        text: "Confirming",
        status: "interrupted",
        tools: [],
      },
    ];
    const state: MobileBotProjectionState = {
      messages: structuredClone(pendingMessages),
      activeRunId: "command-1",
    };
    const running = {
      state: "running" as const,
      run: {
        runId: "command-1",
        admittedAt: "2026-08-29T00:00:00.000Z",
        input: "continue",
        status: "running" as const,
        events: [],
      },
    };

    projectMobileTurnAdmissionLookup(state, "command-1", running);
    expect(state.activeRunId).toBe("command-1");
    expect(state.activeRun?.status).toBe("running");

    projectMobileTurnAdmissionLookup(state, "command-1", {
      state: "terminal",
      run: {
        ...running.run,
        status: "completed",
        responseText: "done",
      },
    });
    expect(state.activeRunId).toBeUndefined();
    expect(state.activeRun).toBeUndefined();
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "done",
      status: "completed",
    });

    const absent: MobileBotProjectionState = {
      messages: structuredClone(pendingMessages),
      activeRunId: "command-1",
    };
    projectMobileTurnAdmissionLookup(absent, "command-1", {
      state: "not-admitted",
    });
    expect(absent.activeRunId).toBeUndefined();
    expect(absent.messages).toEqual([]);
  });
});
