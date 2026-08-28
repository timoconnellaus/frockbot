import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import { createShellBotBackendContribution } from "./backend.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";
import { planBotRunRecovery } from "./backend-recovery.js";

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

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ) as Array<[string, T]>,
      ),
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

describe("Bot recovery", () => {
  test("atomically restores the admitted notification intent after eviction", async () => {
    const storage = new MemoryStorage();
    const admittedSettings = {
      ...initializeBotSettingsV1("primary"),
      profile: { name: "Admitted Bot" },
      notifications: { enabled: true },
    };
    const currentSettings = {
      ...admittedSettings,
      profile: { name: "Current Bot" },
      notifications: { enabled: false },
    };
    const events = [
      {
        type: "assistant/message" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Durable reply",
        toolCalls: [],
      },
      {
        type: "turn/end" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        outcome: "completed" as const,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-1",
      commandFingerprint: botTurnCommandFingerprintV1({
        userId: "user-1",
        botId: "primary",
        runId: "run-1",
        sessionId: "user:primary",
        acceptedAt: "2026-08-28T00:00:00.000Z",
        text: "hello",
      }),
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      configurationSnapshot: admittedSettings,
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      "active-run": run.runId,
      "run:run-1": run,
      "latest-events": events,
      "bot-configuration": currentSettings,
    });

    const recovered = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(recovered.listRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
        responseText: "Durable reply",
      }),
    ]);
    const notifications = await recovered.listNotifications();
    expect(notifications).toEqual([
      expect.objectContaining({
        notificationId: "notification-run-1",
        runId: "run-1",
        title: "Admitted Bot replied",
        body: "Durable reply",
      }),
    ]);

    const recoveredAgain = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await recoveredAgain.listRuns();
    expect(await recoveredAgain.listNotifications()).toEqual(notifications);
  });

  test("keeps an unresolved durable request scheduled when its marker was lost", async () => {
    const storage = new MemoryStorage();
    const settings = initializeBotSettingsV1("primary");
    const events = [
      {
        type: "turn/start" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
      },
      {
        type: "step/start" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
      },
      {
        type: "model/request" as const,
        seq: 2,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        request: {
          requestId: "request-with-lost-marker",
          provider: "provider-1",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-lost-marker",
      commandFingerprint: botTurnCommandFingerprintV1({
        userId: "user-1",
        botId: "primary",
        runId: "run-lost-marker",
        sessionId: "user:primary",
        acceptedAt: "2026-08-28T00:00:00.000Z",
        text: "hello",
      }),
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      configurationSnapshot: settings,
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      "active-run": run.runId,
      "run:run-lost-marker": run,
      "latest-events": events,
    });
    const recovered = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(recovered.listRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: "run-lost-marker",
        status: "reconciliation-required",
        phase: "reconciliation-required",
      }),
    ]);
    expect(storage.values.get("active-run")).toBe("run-lost-marker");
    expect(typeof storage.alarmAt).toBe("number");
  });

  test("resumes a request whose durable journal proves no effect started", () => {
    const events = [
      {
        type: "model/request" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        request: {
          requestId: "request-with-no-effect",
          provider: "provider-1",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "model/effect-not-started" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        requestId: "request-with-no-effect",
        reason: "provider rejected before dispatch",
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-no-effect",
      commandFingerprint: botTurnCommandFingerprintV1({
        userId: "user-1",
        botId: "primary",
        runId: "run-no-effect",
        sessionId: "user:primary",
        acceptedAt: "2026-08-28T00:00:00.000Z",
        text: "hello",
      }),
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      previousEventCount: 0,
    } satisfies StoredRun;

    expect(planBotRunRecovery(run, events)).toEqual({ kind: "resume" });
  });

  test("replays only an identical completed Turn command", async () => {
    const storage = new MemoryStorage();
    const original = {
      userId: "user-1",
      botId: "primary",
      runId: "run-replay",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      text: "hello",
    };
    const run = {
      runId: original.runId,
      commandFingerprint: botTurnCommandFingerprintV1(original),
      sessionId: original.sessionId,
      acceptedAt: original.acceptedAt,
      input: original.text,
      events: [],
      status: "completed",
      responseText: "Durable reply",
    } satisfies StoredRun;
    await storage.put(`run:${run.runId}`, run);
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.run({
        ...original,
        acceptedAt: "2026-08-29T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      runId: "run-replay",
      text: "Durable reply",
    });
    await expect(
      contribution.run({ ...original, text: "different input" }),
    ).rejects.toThrow(
      'Turn idempotency key "run-replay" was reused for a different command',
    );
    await expect(
      contribution.run({ ...original, sessionId: "user:other" }),
    ).rejects.toThrow(
      'Turn idempotency key "run-replay" was reused for a different command',
    );
    await expect(
      contribution.run({ ...original, userId: "user-2" }),
    ).rejects.toThrow(
      'Turn idempotency key "run-replay" was reused for a different command',
    );
    expect(storage.values.get(`run:${run.runId}`)).toEqual(run);
  });

  test("rejects a Turn collision before recovering durable work", async () => {
    const storage = new MemoryStorage();
    const original = {
      userId: "user-1",
      botId: "primary",
      runId: "run-collision",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      text: "original input",
    };
    const events = [
      {
        type: "assistant/message" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        requestId: "request-collision",
        text: "Durable reply",
        toolCalls: [],
      },
      {
        type: "turn/end" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:02.000Z",
        turn: 1,
        outcome: "completed" as const,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: original.runId,
      commandFingerprint: botTurnCommandFingerprintV1(original),
      sessionId: original.sessionId,
      acceptedAt: original.acceptedAt,
      input: original.text,
      events,
      status: "running",
      phase: "executing",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": events,
    });
    storage.alarmAt = Date.parse("2026-08-28T00:05:00.000Z");
    const before = structuredClone([...storage.values.entries()]);
    const alarmBefore = storage.alarmAt;
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.run({ ...original, text: "colliding input" }),
    ).rejects.toThrow(
      'Turn idempotency key "run-collision" was reused for a different command',
    );
    expect([...storage.values.entries()]).toEqual(before);
    expect(storage.alarmAt).toBe(alarmBefore);
  });
});
