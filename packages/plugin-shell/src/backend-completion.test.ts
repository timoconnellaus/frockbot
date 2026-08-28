import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import type { BotTurnResult, StoredRun } from "./backend-contracts.js";
import {
  completeStoredRun,
  failStoredRun,
  type RunTerminalKeys,
  type RunTerminalStorage,
} from "./backend-completion.js";

const keys: RunTerminalKeys = {
  run: "run:run-1",
  activeRun: "active-run",
  latestEvents: "latest-events",
  notificationPrefix: "notification:",
};

const ended = {
  type: "turn/end" as const,
  seq: 0,
  timestamp: "2026-08-28T00:00:00.000Z",
  turn: 1,
  outcome: "completed" as const,
};

function storedRun(): StoredRun {
  return {
    runId: "run-1",
    sessionId: "user:primary",
    acceptedAt: "2026-08-28T00:00:00.000Z",
    input: "hello",
    events: [ended],
    status: "running",
    phase: "executing",
  };
}

function result(): BotTurnResult {
  return {
    runId: "run-1",
    text: "Done",
    events: [ended],
    notification: {
      notificationId: "notification-run-1",
      runId: "run-1",
      createdAt: "2026-08-28T00:00:01.000Z",
      title: "Bot replied",
      body: "Done",
    },
  };
}

class MemoryRunStorage implements RunTerminalStorage {
  readonly values = new Map<string, unknown>([
    [keys.run, storedRun()],
    [keys.activeRun, "run-1"],
    [keys.latestEvents, []],
  ]);
  putFailure: Error | undefined;
  putBatches: Array<Record<string, unknown>> = [];

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(entries: Record<string, unknown>): Promise<void> {
    this.putBatches.push(structuredClone(entries));
    if (this.putFailure) return Promise.reject(this.putFailure);
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, structuredClone(value));
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
}

describe("Bot run terminal persistence", () => {
  test("commits completion and notification in one durable batch", async () => {
    const storage = new MemoryRunStorage();

    await completeStoredRun(storage, keys, "run-1", [], result());

    expect(storage.putBatches).toHaveLength(1);
    expect(storage.putBatches[0]).toHaveProperty(keys.run);
    expect(storage.putBatches[0]).toHaveProperty(
      "notification:notification-run-1",
    );
    expect(storage.values.get(keys.run)).toMatchObject({ status: "completed" });
    expect(storage.values.has(keys.activeRun)).toBe(false);
  });

  test("does not leave a success notification when completion rolls back", async () => {
    const storage = new MemoryRunStorage();
    storage.putFailure = new Error("completion transaction failed");

    await expect(
      completeStoredRun(storage, keys, "run-1", [], result()),
    ).rejects.toThrow("completion transaction failed");
    storage.putFailure = undefined;
    await failStoredRun(
      storage,
      keys,
      "run-1",
      [],
      [ended],
      "completion transaction failed",
    );

    expect(storage.values.get(keys.run)).toMatchObject({ status: "failed" });
    expect(storage.values.has("notification:notification-run-1")).toBe(false);
  });

  test("preserves committed success after an uncertain response", async () => {
    const storage = new MemoryRunStorage();
    await completeStoredRun(storage, keys, "run-1", [], result());

    await expect(
      failStoredRun(
        storage,
        keys,
        "run-1",
        [],
        [
          {
            ...ended,
            outcome: "model-error",
          } satisfies SessionEvent,
        ],
        "completion response lost",
      ),
    ).resolves.toBe("preserved-completion");

    expect(storage.values.get(keys.run)).toMatchObject({ status: "completed" });
    expect(storage.values.has("notification:notification-run-1")).toBe(true);
  });
});
