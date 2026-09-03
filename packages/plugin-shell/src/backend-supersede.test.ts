/**
 * What a superseded Turn does to the durable state the Shell owns: how its
 * unsettled effects are classified, what it leaves for the Turn that replaced
 * it, and what a Stop arriving afterwards is allowed to touch.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createShellBotBackendContribution,
  type ShellBotBackendHost,
} from "./backend.js";
import {
  botTurnCommandFingerprintV1,
  type StoredRun,
} from "./backend-contracts.js";
import { planInterruptedRunRecoveryV1 } from "./backend-recovery.js";
import { projectClientRunV1 } from "./run-protocol.js";
import { TaskStore } from "@frockbot/plugin-subagents/store";

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

function host(storage: MemoryStorage): ShellBotBackendHost {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: () => "user-id",
        get: () => ({ readConfiguration: () => Promise.resolve(user) }),
      },
    } as unknown as ShellBotBackendHost["env"],
  };
}

const identity = { userId: "user-1", botId: "primary" };
const turn = {
  ...identity,
  runId: "run-1",
  sessionId: "user-1:primary",
  acceptedAt: "2026-09-03T00:00:00.000Z",
  text: "hello",
};
const timestamp = "2026-09-03T00:00:01.000Z";

function events(...inputs: Record<string, unknown>[]): SessionEvent[] {
  return inputs.map(
    (event, seq) => ({ ...event, seq, timestamp }) as SessionEvent,
  );
}

/** A Turn that had dispatched a model request and asked a tool to run. */
function toolIntentEvents(): SessionEvent[] {
  return events(
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "model/request",
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
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "on it",
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
  );
}

function storedRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: turn.runId,
    commandFingerprint: botTurnCommandFingerprintV1(turn),
    sessionId: turn.sessionId,
    acceptedAt: turn.acceptedAt,
    input: turn.text,
    events: [],
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: initializeBotSettingsV1(identity.botId),
    previousEventCount: 0,
    ...overrides,
  } as StoredRun;
}

async function fixture(run: StoredRun = storedRun()): Promise<{
  storage: MemoryStorage;
  contribution: ReturnType<typeof createShellBotBackendContribution>;
}> {
  const storage = new MemoryStorage();
  const contribution = createShellBotBackendContribution(host(storage));
  await contribution.materializeSettings(identity, { name: "Primary" });
  storage.values.set(`run:${run.runId}`, structuredClone(run));
  storage.values.set("active-run", run.runId);
  return { storage, contribution };
}

describe("a superseded run settles its effects exactly as a stopped one does", () => {
  test("a tool effect that was never admitted is interrupted, never re-run", () => {
    const run = storedRun({
      events: toolIntentEvents(),
      supersededAt: timestamp,
      supersededBy: "run-2",
      effectAdmissions: [
        { kind: "model", effectId: "request-1", outcome: "admitted" },
        { kind: "tool", effectId: "tool:1:1:0", outcome: "fenced" },
      ],
    });

    const plan = planInterruptedRunRecoveryV1(run, run.events);

    expect(plan.kind).toBe("cancel");
    if (plan.kind !== "cancel") throw new Error("expected cancellation");
    expect(
      plan.events.find((event) => event.type === "tool/result"),
    ).toMatchObject({ status: "interrupted", isError: true });
    expect(plan.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "interrupted",
    });
  });

  test("a tool effect that was admitted reconciles rather than settling", () => {
    const run = storedRun({
      events: toolIntentEvents(),
      supersededAt: timestamp,
      supersededBy: "run-2",
      effectAdmissions: [
        { kind: "model", effectId: "request-1", outcome: "admitted" },
        { kind: "tool", effectId: "tool:1:1:0", outcome: "admitted" },
      ],
    });

    // Identical to Stop: an effect that may already have run is retrieved, not
    // assumed away, and the Turn that replaced it waits for the answer.
    expect(planInterruptedRunRecoveryV1(run, run.events)).toEqual({
      kind: "reconcile",
    });
  });

  test("a run carrying neither intent is refused a plan", () => {
    expect(() =>
      planInterruptedRunRecoveryV1(
        storedRun({ events: toolIntentEvents() }),
        toolIntentEvents(),
      ),
    ).toThrow(`run "${turn.runId}" has no durable stop or supersede intent`);
  });
});

describe("Stop and supersede on the same Turn", () => {
  test("Stop still records its intent on a superseded Turn", async () => {
    const { storage, contribution } = await fixture(
      storedRun({
        events: toolIntentEvents(),
        supersededAt: timestamp,
        supersededBy: "run-2",
      }),
    );

    const receipt = await contribution.stopRun(identity, {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: turn.runId,
    });

    expect(receipt.run.stopRequestedAt).toBeString();
    const stored = storage.values.get(`run:${turn.runId}`) as StoredRun;
    expect(stored.stopRequestedAt).toBeString();
    // Both intents stand. Stop is the outcome the settlement writes, because
    // the User asked for this Turn to stop and a later message does not turn
    // their cancellation into something else.
    expect(stored.supersededAt).toBe(timestamp);
  });

  test("Stop leaves a Turn already admitted as the next one alone", async () => {
    const { storage, contribution } = await fixture(
      storedRun({ events: toolIntentEvents(), supersededAt: timestamp }),
    );
    const queued = storedRun({
      runId: "run-2",
      acceptedAt: "2026-09-03T00:00:02.000Z",
      input: "second",
      phase: "queued",
      previousEventCount: 0,
    });
    storage.values.set("run:run-2", structuredClone(queued));
    storage.values.set("pending-run", "run-2");

    await contribution.stopRun(identity, {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: turn.runId,
    });

    expect(storage.values.get("pending-run")).toBe("run-2");
    expect((storage.values.get("run:run-2") as StoredRun).status).toBe(
      "running",
    );
  });
});

describe("background work outlives the Turn that dispatched it", () => {
  test("a subagent of a superseded Turn still settles, and is recorded", async () => {
    const { storage, contribution } = await fixture(
      storedRun({
        events: [
          ...toolIntentEvents(),
          ...events({
            type: "task/dispatched",
            turn: 1,
            step: 1,
            occurrenceId: "tool:1:1:0",
            taskId: "tk-1",
            taskType: "executor",
            description: "Read the release notes",
            model: "foundation/foundation-model",
            background: true,
          }),
        ],
        supersededAt: timestamp,
        supersededBy: "run-2",
      }),
    );
    const tasks = new TaskStore(
      storage as unknown as ConstructorParameters<typeof TaskStore>[0],
    );
    const admitted = await tasks.admit({
      taskId: "tk-1",
      type: "executor",
      description: "Read the release notes",
      promptDigest: "a".repeat(64),
      model: {
        binding: {
          packageId: "provider-foundation",
          capabilityId: "foundation",
          connectionId: "cn-1",
          provider: "foundation",
          providerModelId: "foundation-model",
        },
        slug: "provider-foundation/foundation-model",
      },
      compositionGenerationId: "generation-1",
      background: true,
      attachments: [],
      dispatch: {
        runId: turn.runId,
        turnId: turn.runId,
        sessionId: turn.sessionId,
      },
      now: new Date(timestamp),
    });
    expect(admitted.status).toBe("admitted");

    // The parent Turn was superseded; nothing asked the child to stop, and its
    // settlement is written exactly as it would have been.
    const settled = await contribution.settleTask(identity, "tk-1", {
      status: "completed",
      settledAt: "2026-09-03T00:00:09.000Z",
      summary: "The notes mention two breaking changes.",
    });

    expect(settled.status).toBe("settled");
    expect(await tasks.read("tk-1")).toMatchObject({
      taskId: "tk-1",
      status: "completed",
    });
  });
});

describe("the projection tells the three states apart", () => {
  test("queued, running, and superseded each project distinctly", () => {
    const queued = projectClientRunV1(
      storedRun({ runId: "run-2", phase: "queued", input: "second" }),
    );
    expect(queued).toMatchObject({ status: "running", queued: true });

    const running = projectClientRunV1(storedRun({ phase: "executing" }));
    expect(running.status).toBe("running");
    expect(running.queued).toBeUndefined();

    const superseded = projectClientRunV1(
      storedRun({
        status: "superseded",
        supersededAt: timestamp,
        supersededBy: "run-2",
        events: [],
      }),
    );
    expect(superseded).toMatchObject({
      status: "superseded",
      outcome: { type: "superseded" },
    });
    expect(superseded.queued).toBeUndefined();
  });
});
