import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import { createShellBotBackendContribution } from "./backend.js";
import type { StoredRun } from "./backend-contracts.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: {
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.end === undefined || key < options.end),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

const IDENTITY = { userId: "user-1", botId: "primary" };

function storedRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint",
    sessionId: "user:primary",
    acceptedAt: "2026-08-28T00:00:00.000Z",
    input: "hello",
    events: [],
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 0,
    ...overrides,
  } as StoredRun;
}

function contributionOver(storage: MemoryStorage) {
  return createShellBotBackendContribution({
    state: { storage } as unknown as DurableObjectState,
    env: {} as never,
  });
}

describe("Bot debug snapshot", () => {
  test("reports the wedged active run with the events the client view hides", async () => {
    const storage = new MemoryStorage();
    const run = storedRun({
      events: [
        { type: "turn/start", turn: 1, seq: 1, timestamp: IDENTITY.userId },
        {
          type: "tool/call",
          turn: 1,
          step: 1,
          occurrenceId: "call-1",
          name: "shell",
          input: { command: "ls" },
          seq: 2,
          timestamp: "2026-08-28T00:00:01.000Z",
        },
      ] as StoredRun["events"],
    });
    await storage.put({
      identity: IDENTITY,
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      [`run-index:${run.acceptedAt}:${run.runId}`]: run.runId,
    });

    const snapshot = await contributionOver(storage).debugSnapshot(IDENTITY, {
      schemaVersion: 1,
      events: true,
    });

    expect(snapshot.activeRunId).toBe("run-1");
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      runId: "run-1",
      status: "running",
      phase: "executing",
      eventCount: 2,
    });
    // The client projection drops `input`; the operator view is the reason
    // this surface exists.
    expect(snapshot.runs[0]!.events).toContainEqual(
      expect.objectContaining({ name: "shell", input: { command: "ls" } }),
    );
  });

  test("carries the failure of a failed run", async () => {
    const storage = new MemoryStorage();
    const run = storedRun({
      runId: "run-failed",
      status: "failed",
      failure: "model connection is unavailable",
    });
    await storage.put({
      identity: IDENTITY,
      [`run:${run.runId}`]: run,
      [`run-index:${run.acceptedAt}:${run.runId}`]: run.runId,
    });

    const snapshot = await contributionOver(storage).debugSnapshot(IDENTITY);

    expect(snapshot.runs[0]).toMatchObject({
      runId: "run-failed",
      status: "failed",
      failure: "model connection is unavailable",
    });
    expect(snapshot.activeRunId).toBeUndefined();
  });

  test("includes an active run older than the page it would otherwise fall off", async () => {
    const storage = new MemoryStorage();
    const stale = storedRun({
      runId: "run-stale",
      acceptedAt: "2026-08-27T00:00:00.000Z",
    });
    const recent = storedRun({
      runId: "run-recent",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      status: "completed",
      phase: "admitted",
      responseText: "done",
    });
    await storage.put({
      identity: IDENTITY,
      "active-run": stale.runId,
      [`run:${stale.runId}`]: stale,
      [`run:${recent.runId}`]: recent,
      [`run-index:${stale.acceptedAt}:${stale.runId}`]: stale.runId,
      [`run-index:${recent.acceptedAt}:${recent.runId}`]: recent.runId,
    });

    const snapshot = await contributionOver(storage).debugSnapshot(IDENTITY, {
      schemaVersion: 1,
      limit: 1,
    });

    expect(snapshot.runs.map((run) => run.runId)).toContain("run-stale");
  });

  test("does not disturb the run it is looking at", async () => {
    const storage = new MemoryStorage();
    const run = storedRun({ runId: "run-wedged" });
    await storage.put({
      identity: IDENTITY,
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      [`run-index:${run.acceptedAt}:${run.runId}`]: run.runId,
    });

    await contributionOver(storage).debugSnapshot(IDENTITY);

    expect(await storage.get<string>("active-run")).toBe("run-wedged");
    expect(await storage.get<StoredRun>(`run:${run.runId}`)).toEqual(run);
  });
});
