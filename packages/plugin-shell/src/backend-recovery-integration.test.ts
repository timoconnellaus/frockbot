import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import { createShellBotBackendContribution } from "./backend.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";
import { planBotRunRecovery } from "./backend-recovery.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  clientRunListWireBytes,
} from "./run-protocol.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly listRequests: Array<{
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }> = [];
  readonly gets: string[] = [];
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key);
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
    this.listRequests.push(options);
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
        type: "assistant/message" as const,
        seq: 2,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Durable reply",
        toolCalls: [],
      },
      {
        type: "step/end" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        outcome: "completed" as const,
      },
      {
        type: "turn/end" as const,
        seq: 4,
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
      "run-index:2026-08-28T00:00:00.000Z:run-1": run.runId,
      "latest-events": events,
      "bot-configuration": currentSettings,
    });

    const recovered = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(recovered.listRuns()).resolves.toEqual({
      schemaVersion: 1,
      runs: [
        expect.objectContaining({
          schemaVersion: 1,
          runId: "run-1",
          status: "completed",
          outcome: { type: "completed", text: "Durable reply" },
        }),
      ],
      page: { truncated: false },
    });
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

    await expect(recovered.listRuns()).resolves.toEqual({
      schemaVersion: 1,
      runs: [
        expect.objectContaining({
          schemaVersion: 1,
          runId: "run-lost-marker",
          status: "reconciliation-required",
          recovery: expect.objectContaining({ action: "resume" }),
        }),
      ],
      page: { truncated: false },
    });
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

  test("fails an ended step whose tool result has no durable intent", () => {
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
        type: "assistant/message" as const,
        seq: 2,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        requestId: "completed-request",
        text: "",
        toolCalls: [
          { id: "provider-call", name: "echo", input: { value: "unsafe" } },
        ],
      },
      {
        type: "tool/result" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "echo",
        content: "unsafe",
        isError: false,
        status: "completed" as const,
      },
      {
        type: "step/end" as const,
        seq: 4,
        timestamp: "2026-08-28T00:00:02.000Z",
        turn: 1,
        step: 1,
        outcome: "completed" as const,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-malformed-tool",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      previousEventCount: 0,
    } satisfies StoredRun;

    expect(planBotRunRecovery(run, events)).toEqual({
      kind: "fail",
      failure:
        'Invalid durable tool journal: tool occurrence "tool:1:1:0" has a result without intent',
    });
  });

  test("rejects tool effects journaled after their step closed", () => {
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
          requestId: "completed-request",
          provider: "provider-1",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        requestId: "completed-request",
        text: "",
        toolCalls: [
          { id: "provider-call", name: "echo", input: { value: "unsafe" } },
        ],
      },
      {
        type: "step/end" as const,
        seq: 4,
        timestamp: "2026-08-28T00:00:02.000Z",
        turn: 1,
        step: 1,
        outcome: "completed" as const,
      },
      {
        type: "tool/call" as const,
        seq: 5,
        timestamp: "2026-08-28T00:00:03.000Z",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "echo",
        input: { value: "unsafe" },
      },
      {
        type: "tool/result" as const,
        seq: 6,
        timestamp: "2026-08-28T00:00:04.000Z",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "echo",
        content: "unsafe",
        isError: false,
        status: "completed" as const,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-post-closure-tool",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      previousEventCount: 0,
    } satisfies StoredRun;

    expect(planBotRunRecovery(run, events)).toEqual({
      kind: "fail",
      failure:
        'Invalid durable tool journal: tool occurrence "tool:1:1:0" was not settled before step end',
    });
  });

  test.each([
    ["text response", []],
    [
      "assistant tool calls before tool intent",
      [
        {
          id: "durable-call",
          name: "echo",
          input: { value: "resumed" },
        },
      ],
    ],
  ])("resumes a durable %s", (_label, toolCalls) => {
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
          requestId: "completed-request",
          provider: "provider-1",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        requestId: "completed-request",
        text: toolCalls.length === 0 ? "Already durable." : "",
        toolCalls,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-completed-request",
      commandFingerprint: "fingerprint",
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

  test("keeps a journaled tool effect in reconciliation", () => {
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
          requestId: "completed-request",
          provider: "provider-1",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        requestId: "completed-request",
        text: "",
        toolCalls: [
          { id: "uncertain-call", name: "echo", input: { value: "hello" } },
        ],
      },
      {
        type: "tool/call" as const,
        seq: 4,
        timestamp: "2026-08-28T00:00:02.000Z",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "echo",
        input: { value: "hello" },
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-uncertain-tool",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      status: "running",
      phase: "executing",
      previousEventCount: 0,
    } satisfies StoredRun;

    expect(planBotRunRecovery(run, events).kind).toBe("reconcile");
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

  test("looks up one durable command without replaying or scanning runs", async () => {
    const storage = new MemoryStorage();
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.lookupRun({ schemaVersion: 1, runId: "command-1" }),
    ).resolves.toEqual({ schemaVersion: 1, state: "not-admitted" });

    const running = {
      runId: "command-1",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      input: "continue",
      events: [],
      status: "running",
      phase: "executing",
    } satisfies StoredRun;
    await storage.put("run:command-1", running);
    await expect(
      contribution.lookupRun({ schemaVersion: 1, runId: "command-1" }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      state: "running",
      run: { runId: "command-1", status: "running" },
    });

    await storage.put("run:command-1", {
      ...running,
      status: "completed",
      responseText: "done",
    } satisfies StoredRun);
    await expect(
      contribution.lookupRun({ schemaVersion: 1, runId: "command-1" }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      state: "terminal",
      run: {
        runId: "command-1",
        status: "completed",
        outcome: { type: "completed", text: "done" },
      },
    });
    expect(storage.listRequests).toEqual([]);
    expect(storage.gets).toEqual([
      "run:command-1",
      "run:command-1",
      "run:command-1",
    ]);
  });

  test("authoritatively fences delayed Turn admission", async () => {
    const storage = new MemoryStorage();
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.fenceRunAdmission({
        schemaVersion: 1,
        runId: "command-fenced",
      }),
    ).resolves.toEqual({ schemaVersion: 1, state: "not-admitted" });
    expect(
      await storage.get<boolean>("run-admission-fence:command-fenced"),
    ).toBe(true);

    await expect(
      contribution.run({
        userId: "user-1",
        botId: "primary",
        runId: "command-fenced",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-29T00:00:00.000Z",
        text: "must not execute",
      }),
    ).rejects.toThrow('run "command-fenced" admission was fenced');
    expect(await storage.get("run:command-fenced")).toBeUndefined();
  });

  test("returns admitted state when admission wins the fence transaction", async () => {
    const storage = new MemoryStorage();
    const running = {
      runId: "command-running",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      input: "continue",
      events: [],
      status: "running",
      phase: "executing",
    } satisfies StoredRun;
    await storage.put("run:command-running", running);
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.fenceRunAdmission({
        schemaVersion: 1,
        runId: "command-running",
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      state: "running",
      run: { runId: "command-running" },
    });
    expect(
      await storage.get("run-admission-fence:command-running"),
    ).toBeUndefined();
  });

  test("does not scan pre-index run records as a compatibility path", async () => {
    const storage = new MemoryStorage();
    await storage.put("run:unindexed", {
      runId: "unindexed",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "legacy",
      events: [],
      status: "completed",
      responseText: "legacy",
    } satisfies StoredRun);
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    storage.listRequests.length = 0;

    await expect(
      contribution.listRuns({ schemaVersion: 1 }),
    ).resolves.toMatchObject({ schemaVersion: 1, runs: [] });
    expect(
      storage.listRequests.some((request) => request.prefix === "run:"),
    ).toBe(false);
  });

  test("pages large run history with bounded indexed reads and wire bytes", async () => {
    const storage = new MemoryStorage();
    const baseTime = Date.parse("2026-08-28T00:00:00.000Z");
    for (let index = 0; index < 100; index += 1) {
      const runId = `run-${index.toString().padStart(3, "0")}`;
      const acceptedAt = new Date(baseTime + index * 1_000).toISOString();
      const active = index === 99;
      const run = {
        runId,
        commandFingerprint: `fingerprint-${index}`,
        sessionId: "user:primary",
        acceptedAt,
        input: "🧪".repeat(40_000),
        events: [],
        status: active ? "reconciliation-required" : "completed",
        ...(active
          ? { failure: "Provider confirmation required" }
          : { responseText: "📦".repeat(80_000) }),
      } satisfies StoredRun;
      await storage.put({
        [`run:${runId}`]: run,
        [`run-index:${acceptedAt}:${runId}`]: runId,
      });
    }
    await storage.put("active-run", "run-099");
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    storage.gets.length = 0;
    storage.listRequests.length = 0;

    const first = await contribution.listRuns({ schemaVersion: 1 });

    expect(first.runs.length).toBeLessThanOrEqual(CLIENT_RUN_PAGE_LIMIT);
    expect(first.runs.map((run) => run.runId)).toContain("run-099");
    expect(first.runs.map((run) => run.runId)).toContain("run-098");
    expect(first.page).toMatchObject({ truncated: true });
    expect(clientRunListWireBytes(first)).toBeLessThanOrEqual(
      CLIENT_RUN_LIST_MAX_BYTES,
    );
    expect(
      storage.listRequests.find((request) => request.prefix === "run-index:"),
    ).toMatchObject({
      reverse: true,
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
    });
    expect(
      storage.listRequests.some((request) => request.prefix === "run:"),
    ).toBe(false);
    expect(
      storage.gets.filter((key) => key.startsWith("run:")).length,
    ).toBeLessThan(CLIENT_RUN_PAGE_LIMIT);

    const nextCursor = first.page.nextCursor;
    if (!nextCursor) throw new Error("expected a paginated run cursor");
    const second = await contribution.listRuns({
      schemaVersion: 1,
      before: nextCursor,
    });
    expect(second.runs.map((run) => run.runId)).not.toContain("run-099");
    expect(second.runs.map((run) => run.runId)).not.toContain("run-098");
    expect(clientRunListWireBytes(second)).toBeLessThanOrEqual(
      CLIENT_RUN_LIST_MAX_BYTES,
    );
    expect(
      second.runs.every(
        (run, index) =>
          index === 0 ||
          second.runs[index - 1]!.admittedAt.localeCompare(run.admittedAt) <= 0,
      ),
    ).toBe(true);
  });
});
