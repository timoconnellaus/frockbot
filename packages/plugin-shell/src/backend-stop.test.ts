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
import { SessionEventLog } from "@frockbot/kernel-do";

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
  acceptedAt: "2026-08-30T00:00:00.000Z",
  text: "hello",
};

function stopCommand(commandId = "stop-1", runId = turn.runId) {
  return { schemaVersion: 1, action: "stop", commandId, runId };
}

const timestamp = "2026-08-30T00:00:01.000Z";

function modelIntentEvents(): SessionEvent[] {
  return [
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
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

function toolIntentEvents(): SessionEvent[] {
  return [
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

function stopReceiptKeys(storage: MemoryStorage): string[] {
  return [...storage.values.keys()].filter((key) =>
    key.startsWith("stop-receipt:"),
  );
}

describe("durable Stop", () => {
  /*
   * A Turn stopped mid-sentence keeps what it said. The run record stores its
   * journal by range rather than inline, so the receipt has to hydrate it: the
   * production sweep on v0.3.31 pressed Stop on a long reply and watched every
   * word of it disappear, leaving "You stopped this." over an empty bubble.
   */
  test("keeps the words a stopped Turn had already streamed", async () => {
    const streamed = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "assistant/chunk",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Sheep farming begins with",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const { storage, contribution } = await fixture(
      storedRun({
        events: [],
        eventRange: { startSeq: 0, endSeq: streamed.length },
      } as Partial<StoredRun>),
    );
    await new SessionEventLog(storage).rewrite(turn.sessionId, streamed);

    const receipt = await contribution.stopRun(identity, stopCommand());

    expect(receipt.run.partialText).toBe("Sheep farming begins with");
  });

  test("records durable intent and an idempotency receipt", async () => {
    const { storage, contribution } = await fixture();

    const receipt = await contribution.stopRun(identity, stopCommand());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: "accepted",
      commandId: "stop-1",
      runId: turn.runId,
    });
    expect(receipt.run.stopRequestedAt).toBeString();
    // Acknowledgement projects accepted durable state, never terminal
    // cancellation, and the run stays active until its effects settle.
    expect(receipt.run.status).not.toBe("cancelled");
    expect(storage.values.get("active-run")).toBe(turn.runId);
    expect(
      (storage.values.get(`run:${turn.runId}`) as StoredRun).stopRequestedAt,
    ).toBe(receipt.run.stopRequestedAt);
    expect(stopReceiptKeys(storage)).toEqual(["stop-receipt:stop-1"]);
  });

  test("replays an identical command and rejects an identifier collision", async () => {
    const { storage, contribution } = await fixture();

    const first = await contribution.stopRun(identity, stopCommand());
    const replay = await contribution.stopRun(identity, stopCommand());

    expect(replay.run.stopRequestedAt).toBe(first.run.stopRequestedAt);
    expect(stopReceiptKeys(storage)).toEqual(["stop-receipt:stop-1"]);

    await expect(
      contribution.stopRun(identity, stopCommand("stop-1", "run-other")),
    ).rejects.toThrow(
      'Stop idempotency key "stop-1" was reused for a different command',
    );
  });

  test("rejects unknown, mistyped, and already terminal Stop commands", async () => {
    const { storage, contribution } = await fixture();

    await expect(
      contribution.stopRun(identity, { schemaVersion: 1, action: "stop" }),
    ).rejects.toThrow();
    await expect(
      contribution.stopRun(identity, {
        schemaVersion: 1,
        action: "cancel",
        commandId: "stop-2",
        runId: turn.runId,
      }),
    ).rejects.toThrow();
    await expect(
      contribution.stopRun(identity, stopCommand("stop-3", "missing-run")),
    ).rejects.toThrow('run "missing-run" was not admitted');

    storage.values.set(
      `run:${turn.runId}`,
      storedRun({
        events: [
          {
            type: "turn/end",
            seq: 0,
            timestamp,
            turn: 1,
            outcome: "completed",
          },
        ] as SessionEvent[],
      }),
    );
    await expect(
      contribution.stopRun(identity, stopCommand("stop-4")),
    ).rejects.toThrow(`run "${turn.runId}" is already terminal`);

    storage.values.set(
      `run:${turn.runId}`,
      storedRun({ status: "completed", responseText: "already answered" }),
    );
    await expect(
      contribution.stopRun(identity, stopCommand("stop-5")),
    ).rejects.toThrow(`run "${turn.runId}" is already terminal`);
  });

  test("refuses a Stop that does not match the Bot's durable identity", async () => {
    const { contribution } = await fixture();

    await expect(
      contribution.stopRun(
        { userId: "user-2", botId: "primary" },
        stopCommand(),
      ),
    ).rejects.toThrow();
  });
});

describe("stopped run recovery", () => {
  test("cancels a stopped run whose model effect was never admitted", async () => {
    const run = storedRun({
      events: modelIntentEvents(),
      stopRequestedAt: timestamp,
      effectAdmissions: [
        { kind: "model", effectId: "request-1", outcome: "fenced" },
      ],
    });

    const plan = planInterruptedRunRecoveryV1(run, run.events);

    expect(plan.kind).toBe("cancel");
    if (plan.kind !== "cancel") throw new Error("expected cancellation");
    expect(plan.events.map((event) => event.type)).toContain(
      "model/effect-not-started",
    );
    // The journal records the Turn as interrupted; the run record becomes
    // terminal `cancelled` when `cancelStoredRun` settles it.
    expect(plan.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "interrupted",
    });
  });

  test("cancels a stopped run whose tool effect was never admitted", async () => {
    const run = storedRun({
      events: toolIntentEvents(),
      stopRequestedAt: timestamp,
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
  });

  test("keeps an admitted but unsettled effect reconciling instead of cancelling", async () => {
    const run = storedRun({
      events: modelIntentEvents(),
      stopRequestedAt: timestamp,
      effectAdmissions: [
        { kind: "model", effectId: "request-1", outcome: "admitted" },
      ],
    });

    expect(planInterruptedRunRecoveryV1(run, run.events)).toEqual({
      kind: "reconcile",
    });
  });

  test("refuses to plan recovery for a run carrying no durable Stop intent", () => {
    const run = storedRun({ events: modelIntentEvents() });

    expect(() => planInterruptedRunRecoveryV1(run, run.events)).toThrow(
      `run "${turn.runId}" has no durable stop or supersede intent`,
    );
  });
});
