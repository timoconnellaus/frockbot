import { shellTestApplicationV1 } from "./backend-application.fixture.js";
import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/core/contracts";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/core/connection";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  SessionEventLog,
  sessionEventLogIndexKeyV1,
} from "@frockbot/core/durable";
import { createShellBotBackendContribution } from "./backend.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";
import { planBotRunRecovery } from "./backend-recovery.js";
import { RUN_FAILURE_COPY_V1 } from "./run-failure-copy.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  CLIENT_RUN_SCAN_LIMIT,
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

/**
 * A Turn caught mid-model-request by a restart: the request is journalled and
 * no outcome ever arrived. Recovery re-issues it under its own requestId, and
 * `provider-1` is not mounted here, so the Turn settles `failed`.
 */
function interruptedModelRequestEvents(): SessionEvent[] {
  return [
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
        requestId: "request-interrupted",
        provider: "provider-1",
        model: "model-1",
        system: "",
        messages: [],
        tools: [],
      },
    },
  ] satisfies SessionEvent[];
}

function interruptedModelRequestRun(
  events: SessionEvent[],
  settings: StoredRun["configurationSnapshot"],
): StoredRun {
  return {
    runId: "run-interrupted",
    commandFingerprint: botTurnCommandFingerprintV1({
      userId: "user-1",
      botId: "primary",
      runId: "run-interrupted",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      text: "hello",
    }),
    sessionId: "user:primary",
    acceptedAt: "2026-08-28T00:00:00.000Z",
    input: "hello",
    events,
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: settings,
    previousEventCount: 0,
  } satisfies StoredRun;
}

describe("Bot recovery", () => {
  test("does not clear active work whose durable run is malformed", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      "active-run": "run-malformed",
      "run:run-malformed": {
        runId: "run-malformed",
        commandFingerprint: "fingerprint",
        sessionId: "user:primary",
        acceptedAt: "2026-08-28T00:00:00.000Z",
        input: "hello",
        events: [],
        phase: "executing",
        compositionGenerationId: "test-composition-generation",
        configurationSnapshot: initializeBotSettingsV1("primary"),
        previousEventCount: 0,
      },
    });
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(contribution.listRuns({ schemaVersion: 1 })).rejects.toThrow(
      "stored run has invalid fields",
    );
    expect(await storage.get<string>("active-run")).toBe("run-malformed");
  });

  test("preserves an active marker whose referenced run is missing", async () => {
    const storage = new MemoryStorage();
    await storage.put("active-run", "run-missing");
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(contribution.listRuns({ schemaVersion: 1 })).resolves.toEqual({
      schemaVersion: 1,
      runs: [],
      page: { truncated: false },
    });

    expect(await storage.get<string>("active-run")).toBe("run-missing");
    expect(typeof storage.alarmAt).toBe("number");
  });

  test("preserves active work when a recovery failure exceeds its durable bound", async () => {
    const storage = new MemoryStorage();
    const occurrenceId = `tool:${"x".repeat(9_000)}`;
    const events = [
      {
        type: "tool/result" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        occurrenceId,
        name: "echo",
        content: "unsafe",
        isError: false,
        status: "completed" as const,
      },
    ];
    const run = {
      runId: "run-oversized-failure",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": events,
    });
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(contribution.listRuns({ schemaVersion: 1 })).rejects.toThrow(
      `run "${run.runId}" has invalid failure`,
    );
    expect(await storage.get<string>("active-run")).toBe(run.runId);
    expect(await storage.get<StoredRun>(`run:${run.runId}`)).toEqual(run);
  });

  test("preserves an active run when durable history is malformed", async () => {
    const storage = new MemoryStorage();
    const run = {
      runId: "run-malformed-history",
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
    } satisfies StoredRun;
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": [{ type: "model/request" }],
    });
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(contribution.listRuns({ schemaVersion: 1 })).rejects.toThrow(
      "session event.seq must be an integer",
    );
    expect(await storage.get<string>("active-run")).toBe(run.runId);
    expect(await storage.get<StoredRun>(`run:${run.runId}`)).toEqual(run);
  });

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
        type: "send/to-user" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        payload: { type: "text" as const, text: "Durable reply" },
      },
      {
        type: "step/end" as const,
        seq: 4,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        outcome: "completed" as const,
      },
      {
        type: "turn/end" as const,
        seq: 5,
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
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
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(recovered.listRuns()).resolves.toEqual({
      schemaVersion: 1,
      runs: [
        expect.objectContaining({
          schemaVersion: 3,
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
        notificationId: "run-1",
        runId: "run-1",
        title: "Admitted Bot replied",
        body: "Durable reply",
      }),
    ]);

    const recoveredAgain = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await recoveredAgain.listRuns();
    expect(await recoveredAgain.listNotifications()).toEqual(notifications);
  });

  // A request nobody can be asked about is not a parked run: the requestId is
  // the idempotency key, so recovery re-issues the call, and a Turn that still
  // cannot run settles rather than holding the Bot behind a decision.
  test("resumes an unanswered request instead of parking the run", async () => {
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: settings,
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      "run:run-lost-marker": run,
      "latest-events": events,
    });
    const recovered = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    expect(planBotRunRecovery(run, events)).toEqual({ kind: "resume" });

    await recovered.listRuns();

    const settled = storage.values.get("run:run-lost-marker") as StoredRun;
    expect(settled.status).toBe("failed");
    // The Bot is released: nothing is holding the next Turn behind a decision
    // nobody can make.
    expect(storage.values.get("active-run")).toBeUndefined();
    expect(storage.alarmAt).toBeUndefined();
  });

  // A completed Turn already says "Bob replied" in the inbox. A failed one said
  // nothing at all, so a person who was not watching that conversation never
  // learned their Bot had given up.
  test("tells the person once when a Turn settles failed", async () => {
    const storage = new MemoryStorage();
    const settings = {
      ...initializeBotSettingsV1("primary"),
      profile: { name: "Bob" },
      notifications: { enabled: true },
    };
    const events = interruptedModelRequestEvents();
    const run = interruptedModelRequestRun(events, settings);
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": events,
    });
    const recovered = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await recovered.listRuns();

    const [notification, ...rest] = await recovered.listNotifications();
    expect(rest).toEqual([]);
    expect(notification).toMatchObject({
      runId: run.runId,
      title: "Bob couldn't finish",
      // The sentence written for the person, never the stored diagnostic.
      body: RUN_FAILURE_COPY_V1.interrupted,
    });
    expect(notification?.body).not.toContain("provider-1");

    // Acknowledged, then recovered again: one failure is one notification, and
    // a replay never resurrects one the person has already read.
    await recovered.acknowledgeNotification(notification!.notificationId);
    const again = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await again.listRuns();
    expect(await again.listNotifications()).toEqual([]);
  });

  test("records no failure notification when the Bot is muted", async () => {
    const storage = new MemoryStorage();
    const settings = {
      ...initializeBotSettingsV1("primary"),
      profile: { name: "Bob" },
      notifications: { enabled: false },
    };
    const events = interruptedModelRequestEvents();
    const run = interruptedModelRequestRun(events, settings);
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": events,
    });
    const recovered = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await recovered.listRuns();

    expect((storage.values.get(`run:${run.runId}`) as StoredRun).status).toBe(
      "failed",
    );
    expect(await recovered.listNotifications()).toEqual([]);
  });

  test("resumes an unanswered request, which is re-issued under its own key", () => {
    const request = {
      requestId: "request-reissued",
      provider: "provider-1",
      model: "model-1",
      system: "",
      messages: [],
      tools: [],
    };
    const events = [
      {
        type: "model/request" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
        step: 1,
        request,
      },
      // A second dispatch of the one call: same key, so the provider answers
      // it at most once however many times the loop sends it.
      {
        type: "model/request" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        request,
      },
    ] satisfies SessionEvent[];
    const run = {
      runId: "run-reissued",
      commandFingerprint: botTurnCommandFingerprintV1({
        userId: "user-1",
        botId: "primary",
        runId: "run-reissued",
        sessionId: "user:primary",
        acceptedAt: "2026-08-28T00:00:00.000Z",
        text: "hello",
      }),
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events,
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;

    expect(planBotRunRecovery(run, events)).toEqual({ kind: "resume" });
  });

  test("resumes a journaled tool occurrence under its own effect id", () => {
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;

    // The occurrence id is the key the tool is executed under, so an
    // occurrence with an intent and no result is simply executed again.
    expect(planBotRunRecovery(run, events).kind).toBe("resume");
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
      effectAdmissions: [],
      status: "completed",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
      responseText: "Durable reply",
    } satisfies StoredRun;
    const notification = {
      notificationId: run.runId,
      runId: run.runId,
      createdAt: "2026-08-28T00:00:01.000Z",
      title: "Bot replied",
      body: "Durable reply",
    };
    await storage.put({
      [`run:${run.runId}`]: run,
      [`notification:${run.runId}`]: notification,
    });
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
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
      notification,
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "active-run": run.runId,
      [`run:${run.runId}`]: run,
      "latest-events": events,
    });
    storage.alarmAt = Date.parse("2026-08-28T00:05:00.000Z");
    const before = structuredClone([...storage.values.entries()]);
    const alarmBefore = storage.alarmAt;
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
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
      ...shellTestApplicationV1(),
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
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
        outcome: { type: "completed", text: "" },
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
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.fenceRunAdmission(
        { userId: "user-1", botId: "primary" },
        {
          schemaVersion: 1,
          runId: "command-fenced",
        },
      ),
    ).resolves.toEqual({ schemaVersion: 1, state: "not-admitted" });
    expect(await storage.get<string[]>("run-admission-fences")).toEqual([
      "command-fenced",
    ]);
    expect(
      await storage.get<{ userId: string; botId: string }>("identity"),
    ).toEqual({
      userId: "user-1",
      botId: "primary",
    });
    await expect(
      contribution.fenceRunAdmission(
        { userId: "other-user", botId: "primary" },
        { schemaVersion: 1, runId: "other-command" },
      ),
    ).rejects.toThrow("Bot authority does not match its durable identity");
    expect(await storage.get<string[]>("run-admission-fences")).toEqual([
      "command-fenced",
    ]);

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

    for (let index = 0; index < 255; index += 1) {
      await contribution.fenceRunAdmission(
        { userId: "user-1", botId: "primary" },
        { schemaVersion: 1, runId: `bounded-fence-${index}` },
      );
    }
    // The index is a bounded FIFO: the oldest fence ages out, and the fence
    // itself always succeeds. Refusing it instead meant a Bot that had refused
    // 256 sends answered every later fence 500, and left the client looping
    // "Turn admission lookup failed".
    await contribution.fenceRunAdmission(
      { userId: "user-1", botId: "primary" },
      { schemaVersion: 1, runId: "fence-over-capacity" },
    );
    const fences = await storage.get<string[]>("run-admission-fences");
    expect(fences).toHaveLength(256);
    expect(fences).toContain("fence-over-capacity");
    expect(fences).not.toContain("command-fenced");
  });

  test("rechecks a fence committed during execution-context resolution", async () => {
    const storage = new MemoryStorage();
    const contextStarted = Promise.withResolvers<void>();
    const continueContext = Promise.withResolvers<void>();
    const user: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "custom-models",
          version: "0.0.1",
          state: "installed",
        },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "ollama-race",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Race",
          state: "ready",
          providerType: "ollama-cloud",
          generation: "generation-race",
          safeMetadata: {},
        },
      ],
      platformModel: {
        connectionId: "ollama-race",
        providerModelId: "model:cloud",
      },
    };
    const settings = initializeBotSettingsV1("primary");
    await storage.put("bot-configuration", settings);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => ({
            readConfiguration: async () => {
              contextStarted.resolve();
              await continueContext.promise;
              return user;
            },
          }),
        },
      } as never,
    });
    const run = contribution.run({
      userId: "user-1",
      botId: "primary",
      runId: "fence-race",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      text: "must remain fenced",
    });
    await contextStarted.promise;
    await contribution.fenceRunAdmission(
      { userId: "user-1", botId: "primary" },
      { schemaVersion: 1, runId: "fence-race" },
    );
    continueContext.resolve();

    await expect(run).rejects.toThrow('run "fence-race" admission was fenced');
    expect(await storage.get("run:fence-race")).toBeUndefined();
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
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put("run:command-running", running);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.fenceRunAdmission(
        { userId: "user-1", botId: "primary" },
        {
          schemaVersion: 1,
          runId: "command-running",
        },
      ),
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
      effectAdmissions: [],
      status: "completed",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
      responseText: "legacy",
    } satisfies StoredRun);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
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

  test("reads the conversation Session once per transcript page request", async () => {
    const storage = new MemoryStorage();
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Housework" },
    );
    const sessionId = "user-1:primary";
    await new SessionEventLog(storage).rewrite(sessionId, [
      {
        type: "turn/start",
        seq: 0,
        timestamp: "2026-09-01T00:00:00.000Z",
        turn: 1,
      },
      {
        type: "turn/end",
        seq: 1,
        timestamp: "2026-09-01T00:00:01.000Z",
        turn: 1,
        outcome: "completed",
      },
      {
        type: "conversation/compacted",
        seq: 2,
        timestamp: "2026-09-01T00:00:02.000Z",
        effectId: "compaction-1",
        fromTurn: 1,
        throughTurn: 1,
        summary: "## Summary\nThe first Turn.",
        identifiers: [],
        provider: "provider-1",
        model: "model-1",
      },
    ]);
    storage.gets.length = 0;

    const page = await contribution.listRuns({ schemaVersion: 1 });

    expect(page.announcements).toMatchObject([
      { type: "conversation/compacted", throughTurn: 1 },
    ]);
    // Every full Session-log pass starts at its index. One index read means
    // marker collection and marker placement shared the same event pass.
    expect(
      storage.gets.filter(
        (key) => key === sessionEventLogIndexKeyV1(sessionId),
      ),
    ).toHaveLength(1);
  });

  /**
   * The run index is global; the transcript is one conversation. These cover
   * the shape that used to answer "this conversation is empty" whenever the
   * newest page of the index happened to hold nothing the reader could see.
   */
  async function writeRunHistory(
    storage: MemoryStorage,
    runs: Array<{
      runId: string;
      sessionId: string;
      turnType?: "chat" | "automation";
    }>,
  ): Promise<void> {
    const baseTime = Date.parse("2026-09-01T00:00:00.000Z");
    for (const [index, entry] of runs.entries()) {
      const acceptedAt = new Date(baseTime + index * 1_000).toISOString();
      const run = {
        runId: entry.runId,
        commandFingerprint: `fingerprint-${index}`,
        sessionId: entry.sessionId,
        acceptedAt,
        input: "hello",
        events: [],
        effectAdmissions: [],
        status: "completed",
        phase: "executing",
        compositionGenerationId: "test-composition-generation",
        configurationSnapshot: initializeBotSettingsV1("primary"),
        previousEventCount: 0,
        responseText: "answer",
        ...(entry.turnType && entry.turnType !== "chat"
          ? { admission: { schemaVersion: 1, turnType: entry.turnType } }
          : {}),
      } satisfies StoredRun;
      await storage.put({
        [`run:${entry.runId}`]: run,
        [`run-index:${acceptedAt}:${entry.runId}`]: entry.runId,
      });
    }
  }

  test("reaches an older conversation buried under newer Turns", async () => {
    const storage = new MemoryStorage();
    await writeRunHistory(storage, [
      { runId: "run-older", sessionId: "user:primary:older" },
      ...Array.from({ length: CLIENT_RUN_PAGE_LIMIT + 2 }, (_value, index) => ({
        runId: `run-newer-${index.toString().padStart(3, "0")}`,
        sessionId: "user:primary:newer",
      })),
    ]);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    const page = await contribution.listRuns({
      schemaVersion: 1,
      conversationId: "user:primary:older",
    });

    expect(page.runs.map((run) => run.runId)).toEqual(["run-older"]);
    expect(page.page.truncated).toBe(false);
  });

  test("keeps the visible chat reachable behind a page of automation", async () => {
    const storage = new MemoryStorage();
    await writeRunHistory(storage, [
      { runId: "run-chat", sessionId: "user:primary" },
      ...Array.from({ length: CLIENT_RUN_PAGE_LIMIT + 2 }, (_value, index) => ({
        runId: `run-automation-${index.toString().padStart(3, "0")}`,
        sessionId: "user:primary",
        turnType: "automation" as const,
      })),
    ]);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    const page = await contribution.listRuns({
      schemaVersion: 1,
      conversationId: "user:primary",
    });

    expect(page.runs.map((run) => run.runId)).toEqual(["run-chat"]);
  });

  test("offers a continuation when a scanned page selects nothing", async () => {
    const storage = new MemoryStorage();
    const buried = CLIENT_RUN_SCAN_LIMIT + CLIENT_RUN_PAGE_LIMIT;
    await writeRunHistory(storage, [
      { runId: "run-older", sessionId: "user:primary:older" },
      ...Array.from({ length: buried }, (_value, index) => ({
        runId: `run-newer-${index.toString().padStart(4, "0")}`,
        sessionId: "user:primary:newer",
      })),
    ]);
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    let page = await contribution.listRuns({
      schemaVersion: 1,
      conversationId: "user:primary:older",
    });
    // The budget stops the scan short of the match, so the page must be empty
    // *and* say where to resume. Answering `truncated: false` here is the
    // defect: it told the client the conversation had nothing in it.
    expect(page.runs).toEqual([]);
    expect(page.page.truncated).toBe(true);
    expect(page.page.nextCursor).toBeDefined();

    const seen = new Set<string>();
    let requests = 0;
    while (page.runs.length === 0 && page.page.nextCursor) {
      if (seen.has(page.page.nextCursor)) {
        throw new Error("run list cursor stopped advancing");
      }
      seen.add(page.page.nextCursor);
      requests += 1;
      if (requests > 20) throw new Error("run list did not converge");
      page = await contribution.listRuns({
        schemaVersion: 1,
        conversationId: "user:primary:older",
        before: page.page.nextCursor,
      });
    }

    expect(page.runs.map((run) => run.runId)).toEqual(["run-older"]);
    expect(page.page.truncated).toBe(false);
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
        input: "🧪".repeat(8_000),
        events: [],
        effectAdmissions: [],
        status: active ? "failed" : "completed",
        phase: "executing",
        compositionGenerationId: "test-composition-generation",
        configurationSnapshot: initializeBotSettingsV1("primary"),
        previousEventCount: 0,
        ...(active
          ? { failure: "Bot turn ended with outcome model-error" }
          : { responseText: "📦".repeat(16_000) }),
      } satisfies StoredRun;
      await storage.put({
        [`run:${runId}`]: run,
        [`run-index:${acceptedAt}:${runId}`]: runId,
      });
    }
    await storage.put("active-run", "run-099");
    const contribution = createShellBotBackendContribution({
      ...shellTestApplicationV1(),
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
