import { describe, expect, test } from "bun:test";
import {
  Session,
  type SessionEvent,
  type ToolDefinition,
  validateToolOccurrenceJournal,
} from "@frockbot/agent-core";
import {
  createFoundationResidentRuntime,
  type FoundationAgentPackage,
} from "@frockbot/agent-runtime/runtime";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createShellBotBackendContribution,
  type ShellBotBackendHost,
} from "./backend.js";
import type {
  BotResidentCancellation,
  BotResidentExecution,
  BotResidentTurnExecution,
} from "./backend-execution.js";
import {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
  executeResidentBotTurn,
} from "./backend-runner.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";
import { Context, type Plugin } from "cordis";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
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

  setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

const user: UserSettingsViewV1 = {
  schemaVersion: 1,
  revision: 0,
  profile: { name: "User" },
  packages: [],
  connections: [],
};

function host(
  storage: MemoryStorage,
  execution: BotResidentExecution,
): ShellBotBackendHost {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: () => "user-id",
        get: () => ({ readConfiguration: () => Promise.resolve(user) }),
      },
    } as unknown as ShellBotBackendHost["env"],
    execution,
  };
}

const identity = { userId: "user-1", botId: "primary" };
const turn = {
  ...identity,
  runId: "run-1",
  sessionId: "user-1:primary",
  acceptedAt: "2026-08-30T00:00:00.000Z",
  text: "hello",
};

function stopCommand(commandId = "stop-1", runId = turn.runId) {
  return { schemaVersion: 1, action: "stop", commandId, runId };
}

function modelRequestEvent(seq: number): SessionEvent {
  return {
    type: "model/request",
    seq,
    timestamp: "2026-08-30T00:00:01.000Z",
    turn: 1,
    step: 1,
    request: {
      requestId: "request-1",
      provider: "foundation",
      model: "foundation-model",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    },
  };
}

function modelIntentEvents(): SessionEvent[] {
  const timestamp = "2026-08-30T00:00:01.000Z";
  return [
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "run-1",
      text: "hello",
    },
    modelRequestEvent(0),
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

function modelNotStartedEvent(seq: number): SessionEvent {
  return {
    type: "model/effect-not-started",
    seq,
    timestamp: "2026-08-30T00:00:02.000Z",
    turn: 1,
    step: 1,
    requestId: "request-1",
    reason: "Durable Stop fenced provider execution",
  };
}

function toolIntentEvents(): SessionEvent[] {
  const timestamp = "2026-08-30T00:00:01.000Z";
  return [
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    modelRequestEvent(0),
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "",
      toolCalls: [{ id: "provider-call", name: "effect", input: {} }],
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "effect",
      input: {},
    },
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

function completedNextTurnEvents(startSeq: number): SessionEvent[] {
  const timestamp = "2026-08-30T00:01:00.000Z";
  const firstRequest = modelRequestEvent(0);
  if (firstRequest.type !== "model/request") throw new Error("invalid fixture");
  const request = {
    ...firstRequest,
    turn: 2,
    request: { ...firstRequest.request, requestId: "request-2" },
  };
  return [
    { type: "turn/start", turn: 2 },
    { type: "step/start", turn: 2, step: 1 },
    {
      type: "user/message",
      turn: 2,
      step: 1,
      messageId: "run-2",
      text: "next",
    },
    request,
    {
      type: "assistant/message",
      turn: 2,
      step: 1,
      requestId: "request-2",
      text: "next answer",
      toolCalls: [],
    },
    { type: "step/end", turn: 2, step: 1, outcome: "completed" },
    { type: "turn/end", turn: 2, outcome: "completed" },
  ].map((event, index) => ({
    ...event,
    seq: startSeq + index,
    timestamp,
  })) as SessionEvent[];
}

function assistantMessageEvent(seq: number): SessionEvent {
  return {
    type: "assistant/message",
    seq,
    timestamp: "2026-08-30T00:00:02.000Z",
    turn: 1,
    step: 1,
    requestId: "request-1",
    text: "reconciled answer",
    toolCalls: [],
  };
}

function storedRunFor(storage: MemoryStorage): StoredRun {
  return storage.values.get(`run:${turn.runId}`) as StoredRun;
}

function notificationKeys(storage: MemoryStorage): string[] {
  return [...storage.values.keys()].filter((key) =>
    key.startsWith("notification:"),
  );
}

function nextTurnExecution(
  storage: MemoryStorage,
  executions: string[],
): BotResidentExecution {
  return {
    project: () => Promise.resolve(),
    execute: async (input) => {
      executions.push(input.command.runId);
      if (input.command.runId !== "run-2") {
        throw new Error("stopped effect must not execute during recovery");
      }
      expect(await input.beforeStart()).toBe(true);
      const latest =
        (storage.values.get("latest-events") as SessionEvent[] | undefined) ??
        [];
      const events = completedNextTurnEvents(latest.length);
      await input.persistSessionEvents(
        input.command.sessionId,
        events.slice(0, 4),
      );
      expect(
        await input.admitEffect({ kind: "model", effectId: "request-2" }),
      ).toBe(true);
      await input.persistSessionEvents(
        input.command.sessionId,
        events.slice(4),
      );
      return { runId: "run-2", text: "next answer", events };
    },
    cancel: () => Promise.resolve(false),
    generation: () => 0,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await Bun.sleep(1);
  }
  if (!condition()) throw new Error("condition was never met");
}

interface StopFixture {
  storage: MemoryStorage;
  contribution: ReturnType<typeof createShellBotBackendContribution>;
  cancellations: BotResidentCancellation[];
  intentAtSignal: (string | undefined)[];
  executions: BotResidentTurnExecution[];
  settle(error: unknown): void;
}

interface ResidentExecutionFixture {
  execution: BotResidentExecution;
  dispose(): Promise<void>;
}

function fixtureAgentPackage(
  id: string,
  plugin: Plugin.Function,
): FoundationAgentPackage {
  return {
    specifier: `fixture-${id}`,
    contributionSpecifier: `fixture-${id}/agent`,
    manifest: {},
    plugin,
  };
}

async function residentExecutionFixture(
  agentPackages: readonly FoundationAgentPackage[],
  rejectBeforeAdmission?: {
    kind: "model" | "tool";
    reached(): void;
    waitUntilRejected(): Promise<void>;
  },
): Promise<ResidentExecutionFixture> {
  const root = new Context();
  const runtime = await createFoundationResidentRuntime(root);
  const execution: BotResidentExecution = {
    project: (projection) =>
      runtime.project({
        generation: projection.generation,
        agentPackages,
        systemPromptSection: projection.systemPromptSection,
      }),
    execute: (input) =>
      executeResidentBotTurn(runtime, {
        ...input,
        admitEffect: async (effect) => {
          if (effect.kind === rejectBeforeAdmission?.kind) {
            rejectBeforeAdmission.reached();
            await rejectBeforeAdmission.waitUntilRejected();
            throw new Error(`${effect.kind} rejected before effect admission`);
          }
          return input.admitEffect(effect);
        },
      }),
    cancel: (cancellation) => Promise.resolve(runtime.cancel(cancellation)),
    generation: () => runtime.generation,
  };
  return {
    execution,
    dispose: async () => {
      await runtime.dispose();
      await root.fiber.dispose();
    },
  };
}

function invocationPackage(input: {
  modelStream(): void;
  tool?: ToolDefinition;
  requestTool?: string;
}): FoundationAgentPackage {
  const plugin: Plugin.Function = (ctx) => {
    const unregisterStream = ctx.on("llm/stream", (request, signal, next) => {
      input.modelStream();
      if (!input.requestTool || request.messages.at(-1)?.role === "tool") {
        return next();
      }
      return (async function* () {
        signal.throwIfAborted();
        yield {
          type: "tool-call" as const,
          call: { id: "provider-call", name: input.requestTool!, input: {} },
        };
        yield { type: "finish" as const, reason: "completed" as const };
      })();
    });
    const unregisterTool = input.tool
      ? ctx.tools.register(input.tool)
      : undefined;
    return () => {
      unregisterTool?.();
      unregisterStream();
    };
  };
  plugin.inject = ["llm", "tools"];
  return fixtureAgentPackage("invocation", plugin);
}

function rejectionGate(kind: "model" | "tool") {
  let reportReached: (() => void) | undefined;
  let releaseRejection: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    reportReached = resolve;
  });
  const rejected = new Promise<void>((resolve) => {
    releaseRejection = resolve;
  });
  return {
    interception: {
      kind,
      reached: () => reportReached?.(),
      waitUntilRejected: () => rejected,
    },
    reached,
    reject: () => releaseRejection?.(),
  };
}

async function materializedFixture(
  onExecute?: (
    input: BotResidentTurnExecution,
    fixture: () => StopFixture,
  ) => Promise<never> | undefined,
): Promise<StopFixture> {
  const storage = new MemoryStorage();
  const cancellations: BotResidentCancellation[] = [];
  const intentAtSignal: (string | undefined)[] = [];
  const executions: BotResidentTurnExecution[] = [];
  let settle: ((error: unknown) => void) | undefined;
  const execution: BotResidentExecution = {
    project: () => Promise.resolve(),
    execute: (input) => {
      executions.push(input);
      const scripted = onExecute?.(input, () => fixture);
      if (scripted) return scripted;
      return new Promise<never>((_resolve, reject) => {
        settle = reject;
      });
    },
    cancel: (cancellation) => {
      cancellations.push(cancellation);
      intentAtSignal.push(storedRunFor(storage)?.stopRequestedAt);
      return Promise.resolve(true);
    },
    generation: () => 0,
  };
  const contribution = createShellBotBackendContribution(
    host(storage, execution),
  );
  await contribution.materializeSettings(identity, { name: "Primary" });
  const fixture: StopFixture = {
    storage,
    contribution,
    cancellations,
    intentAtSignal,
    executions,
    settle: (error) => settle?.(error),
  };
  return fixture;
}

describe("durable Stop", () => {
  test("serializes archive against Turn admission before Agent execution", async () => {
    const fixture = await materializedFixture();
    let checked: (() => void) | undefined;
    let release: (() => void) | undefined;
    const checking = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let archived = false;
    let executions = 0;
    const execution: BotResidentExecution = {
      project: () => Promise.resolve(),
      execute: () => {
        executions += 1;
        return Promise.reject(new Error("archived Bot must not execute"));
      },
      cancel: () => Promise.resolve(false),
      generation: () => 0,
    };
    const contribution = createShellBotBackendContribution({
      ...host(fixture.storage, execution),
      assertLifecycleActive: async () => {
        checked?.();
        await released;
        if (archived) throw new Error("Bot is archived");
      },
    });
    const running = contribution.run(turn);
    await checking;
    archived = true;
    release?.();
    await expect(running).rejects.toThrow("archived");
    expect(executions).toBe(0);
    expect(fixture.storage.values.get("active-run")).toBeUndefined();
  });

  test("fences Agent activation when Stop wins during runtime startup", async () => {
    let effects = 0;
    const fixture = await materializedFixture((input, current) =>
      (async () => {
        await waitFor(() => current().cancellations.length > 0);
        if (await input.beforeStart()) effects += 1;
        throw new BotTurnExecutionError(
          "resident Bot execution was durably fenced",
          [],
        );
      })(),
    );

    const running = fixture.contribution.run(turn);
    await waitFor(() => fixture.executions.length === 1);
    await fixture.contribution.stopRun(identity, stopCommand());
    await expect(running).rejects.toThrow(
      "resident Bot execution was durably fenced",
    );

    expect(effects).toBe(0);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
    });
    expect(fixture.storage.values.get("active-run")).toBeUndefined();
  });

  test("serializes Stop before the exact model effect admission", async () => {
    const admissions: Array<{ kind: "model" | "tool"; effectId: string }> = [];
    let providerCalls = 0;
    const fixture = await materializedFixture((input, current) =>
      (async () => {
        expect(await input.beforeStart()).toBe(true);
        await input.persistSessionEvents(input.command.sessionId, [
          modelRequestEvent(0),
        ]);
        await expect(
          input.admitEffect({ kind: "model", effectId: "wrong-request" }),
        ).rejects.toThrow("does not match durable intent");
        await waitFor(() => current().cancellations.length > 0);
        const effect = { kind: "model" as const, effectId: "request-1" };
        admissions.push(effect);
        if (await input.admitEffect(effect)) providerCalls += 1;
        await input.persistSessionEvents(input.command.sessionId, [
          modelNotStartedEvent(1),
        ]);
        throw new BotTurnExecutionError(
          "Bot turn ended with outcome cancelled",
          [],
        );
      })(),
    );

    const running = fixture.contribution.run(turn);
    await waitFor(
      () => (storedRunFor(fixture.storage)?.events.length ?? 0) === 1,
    );
    await fixture.contribution.stopRun(identity, stopCommand());
    await expect(running).rejects.toThrow(
      "Bot turn ended with outcome cancelled",
    );

    expect(admissions).toEqual([{ kind: "model", effectId: "request-1" }]);
    expect(providerCalls).toBe(0);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: expect.any(String),
    });
    expect(
      storedRunFor(fixture.storage).events.map((event) => event.type),
    ).toEqual(["model/request", "model/effect-not-started"]);
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("serializes Stop before the exact tool effect admission", async () => {
    const admissions: Array<{ kind: "model" | "tool"; effectId: string }> = [];
    let toolExecutions = 0;
    const fixture = await materializedFixture((input, current) =>
      (async () => {
        expect(await input.beforeStart()).toBe(true);
        const intent = toolIntentEvents();
        await input.persistSessionEvents(input.command.sessionId, intent);
        await expect(
          input.admitEffect({ kind: "tool", effectId: "wrong-tool" }),
        ).rejects.toThrow("does not match durable intent");
        await waitFor(() => current().cancellations.length > 0);
        const effect = { kind: "tool" as const, effectId: "tool:1:1:0" };
        admissions.push(effect);
        if (await input.admitEffect(effect)) toolExecutions += 1;
        await input.persistSessionEvents(input.command.sessionId, [
          {
            type: "tool/result",
            seq: intent.length,
            timestamp: "2026-08-30T00:00:02.000Z",
            turn: 1,
            step: 1,
            occurrenceId: "tool:1:1:0",
            name: "effect",
            content: "Cancelled before tool execution started.",
            isError: true,
            status: "interrupted",
          },
        ]);
        throw new BotTurnExecutionError(
          "Bot turn ended with outcome cancelled",
          [],
        );
      })(),
    );

    const running = fixture.contribution.run(turn);
    await waitFor(
      () => (storedRunFor(fixture.storage)?.events.length ?? 0) > 1,
    );
    await fixture.contribution.stopRun(identity, stopCommand());
    await expect(running).rejects.toThrow(
      "Bot turn ended with outcome cancelled",
    );

    expect(admissions).toEqual([{ kind: "tool", effectId: "tool:1:1:0" }]);
    expect(toolExecutions).toBe(0);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: expect.any(String),
    });
    expect(storedRunFor(fixture.storage).events.slice(-3)).toMatchObject([
      { type: "tool/result", status: "interrupted" },
      { type: "step/end", outcome: "interrupted" },
      { type: "turn/end", outcome: "interrupted" },
    ]);
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("repairs an immediate pre-admission model rejection and runs the next Turn", async () => {
    const storage = new MemoryStorage();
    const gate = rejectionGate("model");
    let providerStreams = 0;
    const firstRuntime = await residentExecutionFixture(
      [
        invocationPackage({
          modelStream: () => {
            providerStreams += 1;
          },
        }),
      ],
      gate.interception,
    );
    let nextRuntime: ResidentExecutionFixture | undefined;
    try {
      const contribution = createShellBotBackendContribution(
        host(storage, firstRuntime.execution),
      );
      await contribution.materializeSettings(identity, { name: "Primary" });

      const running = contribution.run(turn);
      await gate.reached;
      await contribution.stopRun(identity, stopCommand());
      gate.reject();
      await expect(running).rejects.toThrow();

      expect(providerStreams).toBe(0);
      const stopped = storedRunFor(storage);
      expect(stopped.effectAdmissions).toEqual([]);
      expect(
        () => new Session(turn.sessionId, () => {}, stopped.events),
      ).not.toThrow();
      expect(validateToolOccurrenceJournal(stopped.events).size).toBe(0);
      expect(stopped.events.map((event) => event.type)).toEqual([
        "session/created",
        "input/queued",
        "turn/start",
        "input/admitted",
        "step/start",
        "user/message",
        "model/request",
        "model/effect-not-started",
        "step/end",
        "turn/end",
      ]);
      expect(stopped.status).toBe("cancelled");
      expect(storage.values.get("active-run")).toBeUndefined();
      expect(notificationKeys(storage)).toEqual([]);

      await firstRuntime.dispose();
      let nextProviderStreams = 0;
      nextRuntime = await residentExecutionFixture([
        invocationPackage({
          modelStream: () => {
            nextProviderStreams += 1;
          },
        }),
      ]);
      const reconstructed = createShellBotBackendContribution(
        host(storage, nextRuntime.execution),
      );
      const next = await reconstructed.run({
        ...turn,
        runId: "run-2",
        acceptedAt: "2026-08-30T00:01:00.000Z",
        text: "next",
      });
      expect(next).toMatchObject({
        runId: "run-2",
        text: "Cordis runtime: next",
      });
      expect(nextProviderStreams).toBe(1);
    } finally {
      await firstRuntime.dispose();
      await nextRuntime?.dispose();
    }
  });

  test("repairs an immediate pre-admission tool rejection and runs the next Turn", async () => {
    const storage = new MemoryStorage();
    const gate = rejectionGate("tool");
    let modelStreams = 0;
    let toolExecutions = 0;
    const tool: ToolDefinition = {
      name: "effect",
      description: "A test effect",
      inputSchema: { type: "object", additionalProperties: false },
      idempotent: true,
      execute: () => {
        toolExecutions += 1;
        return Promise.resolve({ content: "executed", isError: false });
      },
    };
    const firstRuntime = await residentExecutionFixture(
      [
        invocationPackage({
          modelStream: () => {
            modelStreams += 1;
          },
          requestTool: tool.name,
          tool,
        }),
      ],
      gate.interception,
    );
    let nextRuntime: ResidentExecutionFixture | undefined;
    try {
      const contribution = createShellBotBackendContribution(
        host(storage, firstRuntime.execution),
      );
      await contribution.materializeSettings(identity, { name: "Primary" });

      const running = contribution.run(turn);
      await gate.reached;
      await contribution.stopRun(identity, stopCommand());
      gate.reject();
      await expect(running).rejects.toThrow();

      expect(modelStreams).toBe(1);
      expect(toolExecutions).toBe(0);
      const stopped = storedRunFor(storage);
      expect(
        () => new Session(turn.sessionId, () => {}, stopped.events),
      ).not.toThrow();
      const toolJournal = validateToolOccurrenceJournal(stopped.events);
      expect(toolJournal.size).toBe(1);
      expect([...toolJournal.values()].every((entry) => entry.result)).toBe(
        true,
      );
      expect(stopped.events.slice(-3)).toMatchObject([
        { type: "tool/result", status: "interrupted" },
        { type: "step/end", outcome: "interrupted" },
        { type: "turn/end", outcome: "interrupted" },
      ]);
      expect(stopped.status).toBe("cancelled");
      expect(storage.values.get("active-run")).toBeUndefined();
      expect(notificationKeys(storage)).toEqual([]);

      await firstRuntime.dispose();
      let nextProviderStreams = 0;
      nextRuntime = await residentExecutionFixture([
        invocationPackage({
          modelStream: () => {
            nextProviderStreams += 1;
          },
        }),
      ]);
      const reconstructed = createShellBotBackendContribution(
        host(storage, nextRuntime.execution),
      );
      const next = await reconstructed.run({
        ...turn,
        runId: "run-2",
        acceptedAt: "2026-08-30T00:01:00.000Z",
        text: "next",
      });
      expect(next).toMatchObject({
        runId: "run-2",
        text: "Cordis runtime: next",
      });
      expect(nextProviderStreams).toBe(1);
    } finally {
      await firstRuntime.dispose();
      await nextRuntime?.dispose();
    }
  });

  test("replays one exact admitted outcome and rejects a kind collision", async () => {
    let inspected: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    const fixture = await materializedFixture((input) =>
      (async () => {
        expect(await input.beforeStart()).toBe(true);
        await input.persistSessionEvents(input.command.sessionId, [
          modelRequestEvent(0),
        ]);
        const effect = { kind: "model" as const, effectId: "request-1" };
        expect(await input.admitEffect(effect)).toBe(true);
        expect(await input.admitEffect(effect)).toBe(true);
        await expect(
          input.admitEffect({ kind: "tool", effectId: "request-1" }),
        ).rejects.toThrow("collides with model");
        inspected?.();
        return new Promise<never>(() => {});
      })(),
    );

    void fixture.contribution.run(turn).catch(() => {});
    await ready;

    expect(storedRunFor(fixture.storage).effectAdmissions).toEqual([
      { kind: "model", effectId: "request-1", outcome: "admitted" },
    ]);
  });

  test("repairs a pre-admission model crash and runs the next Turn", async () => {
    let crashed: (() => void) | undefined;
    const crashObserved = new Promise<void>((resolve) => {
      crashed = resolve;
    });
    const fixture = await materializedFixture((input, current) =>
      (async () => {
        expect(await input.beforeStart()).toBe(true);
        await input.persistSessionEvents(
          input.command.sessionId,
          modelIntentEvents(),
        );
        await waitFor(() => current().cancellations.length > 0);
        // Crash before admitEffect: absence is a definitive no-start outcome.
        crashed?.();
        return new Promise<never>(() => {});
      })(),
    );

    void fixture.contribution.run(turn).catch(() => {});
    await waitFor(
      () => (storedRunFor(fixture.storage)?.events.length ?? 0) === 5,
    );
    await fixture.contribution.stopRun(identity, stopCommand());
    await crashObserved;
    expect(storedRunFor(fixture.storage).effectAdmissions).toEqual([]);

    const executions: string[] = [];
    const reconstructed = createShellBotBackendContribution(
      host(fixture.storage, nextTurnExecution(fixture.storage, executions)),
    );
    await reconstructed.alarm();

    expect(executions).toEqual([]);
    const repairedModelLatest = fixture.storage.values.get(
      "latest-events",
    ) as SessionEvent[];
    expect(
      new Session(turn.sessionId, () => {}, repairedModelLatest).events,
    ).toHaveLength(repairedModelLatest.length);
    expect(
      storedRunFor(fixture.storage).events.map((event) => event.type),
    ).toEqual([
      "session/created",
      "turn/start",
      "step/start",
      "user/message",
      "model/request",
      "model/effect-not-started",
      "step/end",
      "turn/end",
    ]);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: expect.any(String),
    });
    expect(fixture.storage.values.get("active-run")).toBeUndefined();

    const next = await reconstructed.run({
      ...turn,
      runId: "run-2",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      text: "next",
    });
    expect(next).toMatchObject({ runId: "run-2", text: "next answer" });
    expect(executions).toEqual(["run-2"]);
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("repairs a pre-admission tool crash and runs the next Turn", async () => {
    let crashed: (() => void) | undefined;
    const crashObserved = new Promise<void>((resolve) => {
      crashed = resolve;
    });
    const fixture = await materializedFixture((input, current) =>
      (async () => {
        expect(await input.beforeStart()).toBe(true);
        await input.persistSessionEvents(
          input.command.sessionId,
          toolIntentEvents(),
        );
        await waitFor(() => current().cancellations.length > 0);
        // Crash before admitEffect: even an idempotent tool was never admitted.
        crashed?.();
        return new Promise<never>(() => {});
      })(),
    );

    void fixture.contribution.run(turn).catch(() => {});
    await waitFor(
      () => (storedRunFor(fixture.storage)?.events.length ?? 0) > 1,
    );
    await fixture.contribution.stopRun(identity, stopCommand());
    await crashObserved;
    expect(storedRunFor(fixture.storage).effectAdmissions).toEqual([]);

    const executions: string[] = [];
    const reconstructed = createShellBotBackendContribution(
      host(fixture.storage, nextTurnExecution(fixture.storage, executions)),
    );
    await reconstructed.alarm();

    expect(executions).toEqual([]);
    const repairedToolLatest = fixture.storage.values.get(
      "latest-events",
    ) as SessionEvent[];
    expect(() =>
      validateToolOccurrenceJournal(repairedToolLatest),
    ).not.toThrow();
    expect(storedRunFor(fixture.storage).events.slice(-3)).toMatchObject([
      { type: "tool/result", status: "interrupted" },
      { type: "step/end", outcome: "interrupted" },
      { type: "turn/end", outcome: "interrupted" },
    ]);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: expect.any(String),
    });
    expect(fixture.storage.values.get("active-run")).toBeUndefined();

    const next = await reconstructed.run({
      ...turn,
      runId: "run-2",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      text: "next",
    });
    expect(next).toMatchObject({ runId: "run-2", text: "next answer" });
    expect(executions).toEqual(["run-2"]);
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("records intent and a receipt before signalling the resident Agent", async () => {
    const fixture = await materializedFixture();
    const running = fixture.contribution.run(turn);
    await waitFor(() => fixture.executions.length === 1);

    const receipt = await fixture.contribution.stopRun(identity, stopCommand());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: "accepted",
      commandId: "stop-1",
      runId: turn.runId,
    });
    expect(receipt.run.stopRequestedAt).toBeString();
    expect(fixture.cancellations).toEqual([
      {
        botId: identity.botId,
        sessionId: turn.sessionId,
        runId: turn.runId,
        reason: "user",
      },
    ]);
    // The durable intent is visible to the Agent signal, never after it.
    expect(fixture.intentAtSignal).toEqual([receipt.run.stopRequestedAt]);
    expect(fixture.storage.values.get("active-run")).toBe(turn.runId);

    fixture.settle(
      new BotTurnExecutionError("Bot turn ended with outcome cancelled", []),
    );
    await expect(running).rejects.toThrow(
      "Bot turn ended with outcome cancelled",
    );

    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: receipt.run.stopRequestedAt,
    });
    expect(storedRunFor(fixture.storage).responseText).toBeUndefined();
    expect(storedRunFor(fixture.storage).failure).toBeUndefined();
    expect(fixture.storage.values.get("active-run")).toBeUndefined();
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("replays an identical command and rejects an identifier collision", async () => {
    const fixture = await materializedFixture();
    const running = fixture.contribution.run(turn);
    await waitFor(() => fixture.executions.length === 1);

    const first = await fixture.contribution.stopRun(identity, stopCommand());
    const replay = await fixture.contribution.stopRun(identity, stopCommand());

    expect(replay.run.stopRequestedAt).toBe(first.run.stopRequestedAt);
    expect(
      [...fixture.storage.values.keys()].filter((key) =>
        key.startsWith("stop-receipt:"),
      ),
    ).toEqual(["stop-receipt:stop-1"]);

    await expect(
      fixture.contribution.stopRun(
        identity,
        stopCommand("stop-1", "run-other"),
      ),
    ).rejects.toThrow(
      'Stop idempotency key "stop-1" was reused for a different command',
    );

    fixture.settle(
      new BotTurnExecutionError("Bot turn ended with outcome cancelled", []),
    );
    await expect(running).rejects.toThrow();
  });

  test("rejects unknown, mistyped, and already terminal Stop commands", async () => {
    const fixture = await materializedFixture();

    await expect(
      fixture.contribution.stopRun(identity, stopCommand("stop-1", "missing")),
    ).rejects.toThrow('run "missing" was not admitted');
    await expect(
      fixture.contribution.stopRun(identity, {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
      }),
    ).rejects.toThrow("run stop command.runId is invalid");
    await expect(
      fixture.contribution.stopRun(
        { userId: "intruder", botId: identity.botId },
        stopCommand(),
      ),
    ).rejects.toThrow("Bot authority does not match its durable identity");

    fixture.storage.values.set(`run:${turn.runId}`, {
      runId: turn.runId,
      commandFingerprint: botTurnCommandFingerprintV1(turn),
      sessionId: turn.sessionId,
      acceptedAt: turn.acceptedAt,
      input: turn.text,
      events: [
        {
          type: "turn/end",
          seq: 0,
          timestamp: "2026-08-30T00:00:01.000Z",
          turn: 1,
          outcome: "completed",
        },
      ],
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      configurationSnapshot: initializeBotSettingsV1(identity.botId),
      previousEventCount: 0,
    } satisfies StoredRun);
    await expect(
      fixture.contribution.stopRun(identity, stopCommand()),
    ).rejects.toThrow(`run "${turn.runId}" is already terminal`);

    fixture.storage.values.set(`run:${turn.runId}`, {
      runId: turn.runId,
      commandFingerprint: botTurnCommandFingerprintV1(turn),
      sessionId: turn.sessionId,
      acceptedAt: turn.acceptedAt,
      input: turn.text,
      events: [],
      effectAdmissions: [],
      status: "completed",
      responseText: "already answered",
      phase: "executing",
      configurationSnapshot: initializeBotSettingsV1(identity.botId),
      previousEventCount: 0,
    } satisfies StoredRun);

    await expect(
      fixture.contribution.stopRun(identity, stopCommand()),
    ).rejects.toThrow(`run "${turn.runId}" is already terminal`);
  });

  test("keeps an uncertain effect reconciling, then cancels after its outcome is journaled", async () => {
    let statusAtRetrieval: StoredRun["status"] | undefined;
    const fixture = await materializedFixture((input, current) => {
      if (input.resume) {
        statusAtRetrieval = storedRunFor(current().storage).status;
        return (async () => {
          await input.persistSessionEvents(input.command.sessionId, [
            assistantMessageEvent(1),
          ]);
          throw new BotTurnExecutionError(
            "Bot turn ended with outcome cancelled",
            [],
          );
        })();
      }
      return (async () => {
        await input.persistSessionEvents(input.command.sessionId, [
          modelRequestEvent(0),
        ]);
        // This effect admission linearizes before the later Stop transaction;
        // its lost outcome therefore requires provider reconciliation.
        expect(
          await input.admitEffect({ kind: "model", effectId: "request-1" }),
        ).toBe(true);
        await waitFor(() => current().cancellations.length > 0);
        throw new BotTurnExecutionError("provider stream aborted", []);
      })();
    });

    const running = fixture.contribution.run(turn);
    await waitFor(
      () => (storedRunFor(fixture.storage)?.events.length ?? 0) === 1,
    );
    await fixture.contribution.stopRun(identity, stopCommand());
    await expect(running).rejects.toThrow();

    // An uncertain model effect stays nonterminal and keeps the active marker.
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "reconciliation-required",
      phase: "reconciling",
    });
    expect(storedRunFor(fixture.storage).stopRequestedAt).toBeString();
    expect(fixture.storage.values.get("active-run")).toBe(turn.runId);

    await expect(
      fixture.contribution.reconcileRun(identity, turn.runId),
    ).rejects.toThrow("Bot turn ended with outcome cancelled");

    expect(statusAtRetrieval).toBe("reconciliation-required");
    // Reconciliation journals the original outcome, then cancels the run.
    const journal = storedRunFor(fixture.storage).events.map(
      (event) => event.type,
    );
    expect(journal).toEqual(["model/request", "assistant/message"]);
    expect(storedRunFor(fixture.storage).status).toBe("cancelled");
    expect(fixture.storage.values.get("active-run")).toBeUndefined();
    expect(notificationKeys(fixture.storage)).toEqual([]);
    expect(fixture.cancellations).toHaveLength(2);
    expect(fixture.executions).toHaveLength(2);
  });

  test("retries an unavailable stopped effect by alarm without terminalizing it", async () => {
    let retrievals = 0;
    const fixture = await materializedFixture((input) => {
      if (!input.resume) throw new Error("alarm recovery must resume");
      retrievals += 1;
      throw new BotTurnReconciliationRequiredError(
        "provider result is still pending",
        [],
      );
    });
    const settings = {
      ...initializeBotSettingsV1(identity.botId),
      profile: { name: "Primary" },
    };
    fixture.storage.values.set(`run:${turn.runId}`, {
      runId: turn.runId,
      commandFingerprint: botTurnCommandFingerprintV1(turn),
      sessionId: turn.sessionId,
      acceptedAt: turn.acceptedAt,
      input: turn.text,
      events: [modelRequestEvent(0)],
      effectAdmissions: [
        { kind: "model", effectId: "request-1", outcome: "admitted" },
      ],
      status: "reconciliation-required",
      phase: "reconciling",
      failure: "provider result is still pending",
      stopRequestedAt: "2026-08-30T00:00:03.000Z",
      configurationSnapshot: settings,
      previousEventCount: 0,
    } satisfies StoredRun);
    fixture.storage.values.set("active-run", turn.runId);
    fixture.storage.values.set("latest-events", [modelRequestEvent(0)]);

    await expect(fixture.contribution.alarm()).rejects.toThrow(
      "provider result is still pending",
    );
    expect(fixture.storage.alarmAt).toBeNumber();
    await expect(fixture.contribution.alarm()).rejects.toThrow(
      "provider result is still pending",
    );

    expect(retrievals).toBe(2);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "reconciliation-required",
      stopRequestedAt: "2026-08-30T00:00:03.000Z",
    });
    expect(fixture.storage.values.get("active-run")).toBe(turn.runId);
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });

  test("settles a stopped run after eviction without starting a new effect", async () => {
    const fixture = await materializedFixture(() => {
      throw new Error("must not execute after Stop");
    });
    const settings = {
      ...initializeBotSettingsV1(identity.botId),
      profile: { name: "Primary" },
    };
    fixture.storage.values.set(`run:${turn.runId}`, {
      runId: turn.runId,
      commandFingerprint: botTurnCommandFingerprintV1(turn),
      sessionId: turn.sessionId,
      acceptedAt: turn.acceptedAt,
      input: turn.text,
      events: [],
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      stopRequestedAt: "2026-08-30T00:00:03.000Z",
      configurationSnapshot: settings,
      previousEventCount: 0,
    } satisfies StoredRun);
    fixture.storage.values.set("active-run", turn.runId);
    fixture.storage.values.set("latest-events", []);

    await fixture.contribution.alarm();

    expect(fixture.executions).toEqual([]);
    expect(storedRunFor(fixture.storage)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: "2026-08-30T00:00:03.000Z",
    });
    expect(fixture.storage.values.get("active-run")).toBeUndefined();
    expect(notificationKeys(fixture.storage)).toEqual([]);
  });
});
