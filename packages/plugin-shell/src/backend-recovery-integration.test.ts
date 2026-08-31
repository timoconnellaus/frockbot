import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
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
  test("executes and reconstructs an Ollama-bound Bot without Foundation fallback", async () => {
    const storage = new MemoryStorage();
    const credentialKeyring =
      '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';
    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(credentialKeyring),
      context: {
        accountId: "user-1",
        connectionId: "ollama-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "ollama-secret",
    });
    const userSettings: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "ollama-1",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          providerType: "ollama-cloud",
          generation: "generation-1",
          safeMetadata: {},
          modelCatalog: {
            schemaVersion: 1,
            generation: "catalog-1",
            state: "fresh",
            models: [
              {
                providerModelId: "glm-5.3-flash:cloud",
                displayName: "GLM",
                capabilities: {
                  tools: true,
                  vision: false,
                  reasoning: false,
                },
                source: "discovered",
              },
            ],
          },
        },
      ],
    };
    const leasedRequests: Array<Record<string, unknown>> = [];
    const settledEffects: string[] = [];
    let settlementFailures = 0;
    const rpc = {
      readConfiguration: () => Promise.resolve(structuredClone(userSettings)),
      getConnection: () =>
        Promise.resolve(structuredClone(userSettings.connections[0])),
      claimConnectionDependency: () => Promise.resolve(true),
      acknowledgeConnectionDependency: () => Promise.resolve(true),
      compensateConnectionDependency: () => Promise.resolve(true),
      leaseModelCredential: (input: unknown) => {
        leasedRequests.push(input as Record<string, unknown>);
        const request = input as { effectId: string };
        return Promise.resolve({
          schemaVersion: 1,
          leaseId: `lease-${leasedRequests.length}`,
          effectId: request.effectId,
          connectionId: "ollama-1",
          credentialGeneration: "generation-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          envelope,
        });
      },
      settleModelCredential: (input: unknown) => {
        settledEffects.push((input as { effectId: string }).effectId);
        if (settlementFailures > 0) {
          settlementFailures -= 1;
          return Promise.reject(new Error("settlement unavailable"));
        }
        return Promise.resolve();
      },
    };
    const requests: Request[] = [];
    let failRequests = false;
    const outboundFetch = ((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (!request.url.startsWith("https://ollama.com/")) {
        return Promise.reject(new Error("Foundation fallback invoked"));
      }
      if (failRequests) return Promise.reject(new Error("response lost"));
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"Ollama reply"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    }) as typeof fetch;
    const host = () =>
      createShellBotBackendContribution({
        state: { storage } as unknown as DurableObjectState,
        env: {
          CREDENTIAL_KEYRING: credentialKeyring,
          USER_CONFIGURATIONS: {
            idFromName: () => "user-configuration-id",
            get: () => rpc,
          },
          MEMORY_FILES: {},
          MEMORY_INDEX: {},
          AI: {},
        } as unknown as Parameters<
          typeof createShellBotBackendContribution
        >[0]["env"],
        outboundFetch,
      });

    const configured = host();
    await configured.materializeSettings(
      { userId: "user-1", botId: "primary" },
      {
        name: "Ollama Bot",
        model: {
          connectionId: "ollama-1",
          providerModelId: "glm-5.3-flash:cloud",
        },
      },
    );
    await configured.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      botId: "primary",
      command: {
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: "assign-ollama-model",
        botId: "primary",
        expectedRevision: 0,
        assignment: {
          assignmentId: "ollama-model",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-1",
        },
      },
    });
    const first = await host().run({
      userId: "user-1",
      botId: "primary",
      runId: "ollama-run-1",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-30T00:00:00.000Z",
      text: "hello",
    });
    const second = await host().run({
      userId: "user-1",
      botId: "primary",
      runId: "ollama-run-2",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      text: "again",
    });

    expect(first.text).toBe("Ollama reply");
    expect(second.text).toBe("Ollama reply");
    expect(requests).toHaveLength(2);
    expect(
      await Promise.all(requests.map((request) => request.clone().json())),
    ).toEqual([
      expect.objectContaining({ model: "glm-5.3-flash:cloud" }),
      expect.objectContaining({ model: "glm-5.3-flash:cloud" }),
    ]);
    expect(
      leasedRequests.map((request) => ({
        connectionId: request.connectionId,
        providerModelId: request.providerModelId,
        connectionGeneration: request.connectionGeneration,
      })),
    ).toEqual([
      {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
        connectionGeneration: "generation-1",
      },
      {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
        connectionGeneration: "generation-1",
      },
    ]);
    expect(settledEffects).toHaveLength(2);
    for (const runId of ["ollama-run-1", "ollama-run-2"]) {
      const run = await storage.get<StoredRun>(`run:${runId}`);
      expect(
        run?.events.find((event) => event.type === "model/request"),
      ).toMatchObject({
        request: {
          provider: "ollama-cloud",
          model: "glm-5.3-flash:cloud",
          modelBinding: {
            connectionId: "ollama-1",
            connectionGeneration: "generation-1",
          },
        },
      });
    }

    settlementFailures = 1;
    await expect(
      host().run({
        userId: "user-1",
        botId: "primary",
        runId: "ollama-run-settlement",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-30T00:01:30.000Z",
        text: "settle durably",
      }),
    ).rejects.toThrow("durable outcome settlement pending");
    expect(
      await storage.get<StoredRun>("run:ollama-run-settlement"),
    ).toMatchObject({ status: "running", phase: "executing" });
    expect(await storage.get<string>("active-run")).toBe(
      "ollama-run-settlement",
    );
    expect(requests).toHaveLength(3);
    userSettings.packages[0] = {
      ...userSettings.packages[0]!,
      state: "disabled",
    };

    await host().alarm();

    expect(
      await storage.get<StoredRun>("run:ollama-run-settlement"),
    ).toMatchObject({ status: "completed" });
    expect(await storage.get("active-run")).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(settledEffects).toHaveLength(4);
    userSettings.packages[0] = {
      ...userSettings.packages[0]!,
      state: "installed",
    };

    failRequests = true;
    await expect(
      host().run({
        userId: "user-1",
        botId: "primary",
        runId: "ollama-run-uncertain",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-30T00:02:00.000Z",
        text: "uncertain",
      }),
    ).rejects.toThrow("response lost");
    expect(
      await storage.get<StoredRun>("run:ollama-run-uncertain"),
    ).toMatchObject({ status: "reconciliation-required" });

    await host().alarm();
    expect(
      await storage.get<StoredRun>("run:ollama-run-uncertain"),
    ).toMatchObject({ status: "reconciliation-required" });
    await expect(
      host().reconcileRun(
        { userId: "user-1", botId: "primary" },
        "ollama-run-uncertain",
      ),
    ).rejects.toThrow();
    expect(
      await storage.get<StoredRun>("run:ollama-run-uncertain"),
    ).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("explicitly abandoned"),
    });
    expect(await storage.get("active-run")).toBeUndefined();
  });

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
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(contribution.listRuns({ schemaVersion: 1 })).rejects.toThrow(
      `run "${run.runId}" has invalid failure`,
    );
    expect(await storage.get<string>("active-run")).toBe(run.runId);
    expect(await storage.get<StoredRun>(`run:${run.runId}`)).toEqual(run);
  });

  test("preserves reconciliation state when durable history is malformed", async () => {
    const storage = new MemoryStorage();
    const run = {
      runId: "run-reconciliation",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: "2026-08-28T00:00:00.000Z",
      input: "hello",
      events: [],
      status: "reconciliation-required",
      phase: "reconciliation-required",
      failure: "Provider confirmation required",
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
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.reconcileRun(
        { userId: "user-1", botId: "primary" },
        run.runId,
      ),
    ).rejects.toThrow("session event.seq must be an integer");
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
        notificationId: "run-1",
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

  test("preserves an unresolved request for an explicit decision", async () => {
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
      compositionGenerationId: "test-composition-generation",
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
    expect(storage.alarmAt).toBeUndefined();
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
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
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
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
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
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
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
    await expect(
      contribution.fenceRunAdmission(
        { userId: "user-1", botId: "primary" },
        { schemaVersion: 1, runId: "fence-over-capacity" },
      ),
    ).rejects.toThrow("Run admission fence capacity reached");
    const fences = await storage.get<string[]>("run-admission-fences");
    expect(fences).toHaveLength(256);
    expect(fences).toContain("command-fenced");
    expect(fences).toContain("bounded-fence-0");
    expect(fences).not.toContain("fence-over-capacity");
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
    };
    const settings = {
      ...initializeBotSettingsV1("primary"),
      model: {
        connectionId: "ollama-race",
        providerModelId: "model:cloud",
      },
      assignments: [
        {
          assignmentId: "model-race",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-race",
          state: "enabled" as const,
        },
      ],
    };
    await storage.put("bot-configuration", settings);
    const contribution = createShellBotBackendContribution({
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
      status: "running",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    } satisfies StoredRun;
    await storage.put("run:command-running", running);
    const contribution = createShellBotBackendContribution({
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
      status: "completed",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
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
        input: "🧪".repeat(8_000),
        events: [],
        status: active ? "reconciliation-required" : "completed",
        phase: active ? "reconciliation-required" : "executing",
        compositionGenerationId: "test-composition-generation",
        configurationSnapshot: initializeBotSettingsV1("primary"),
        previousEventCount: 0,
        ...(active
          ? { failure: "Provider confirmation required" }
          : { responseText: "📦".repeat(16_000) }),
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
