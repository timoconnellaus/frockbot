import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import { bootstrapGeneration } from "./composition/generation.js";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { SessionEventLog } from "./session-event-log.ts";
import { BotTurnParkedError } from "./turn-errors.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";
import { PARKED_RUN_KEY, repairRunKey } from "./storage-keys.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

const identity = { userId: "user-1", botId: "primary" };
const CONVERSATION = "user-1:primary";

let clock = 0;

function command(
  runId: string,
  text: string,
  extra: Partial<OwnedBotTurnCommand> = {},
): OwnedBotTurnCommand {
  clock += 1;
  return {
    ...identity,
    runId,
    sessionId: CONVERSATION,
    acceptedAt: new Date(Date.UTC(2026, 8, 27, 0, 0, clock)).toISOString(),
    text,
    ...extra,
  };
}

function routine(runId: string): OwnedBotTurnCommand {
  return command(runId, "triage the inbox", {
    sessionId: "routine:triage",
    turnType: "automation",
  });
}

interface Gate {
  reached: Promise<void>;
  open(): void;
}

function gate(): Gate & { wait(): Promise<void>; arrive(): void } {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, open, arrive, wait: () => opened };
}

/**
 * An authority whose Package runs each Turn the way the Agent loop does at
 * its step boundaries: a slow run does a model call and a tool call per step
 * and asks, before each next step, whether a person is waiting — parking or
 * ending when told to. A resume starts again from the last closed step in its
 * journal. Every model call and tool effect is counted by its key, so a
 * repeat is visible.
 *
 * A run named in `slow` stops at each boundary until the test opens it; any
 * other run answers in one step.
 */
function createProbe(
  storage: MemoryStorage,
  options: { slow: Record<string, number>; kickDriver?: boolean },
) {
  const effects: string[] = [];
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const settled: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const gateFor = (key: string) => {
    let existing = gates.get(key);
    if (!existing) {
      existing = gate();
      gates.set(key, existing);
    }
    return existing;
  };
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () =>
      bootstrapGeneration({ createdAt: "2026-09-27T00:00:00.000Z" }),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      observed.push(input);
      const runId = input.command.runId;
      const sessionId = input.command.sessionId;
      let seq = input.cursor.nextSeq;
      const persist = async (
        ...events: Omit<SessionEvent, "seq" | "timestamp">[]
      ) => {
        await input.persistSessionEvents(
          sessionId,
          events.map(
            (event) =>
              ({
                ...event,
                seq: seq++,
                timestamp: "2026-09-27T00:00:10.000Z",
              }) as SessionEvent,
          ),
        );
      };
      const step = async (turn: number, index: number, tool: boolean) => {
        const requestId = `request-${runId}-${index}`;
        effects.push(`model:${requestId}`);
        await persist(
          { type: "step/start", turn, step: index } as never,
          {
            type: "model/request",
            turn,
            step: index,
            request: {
              requestId,
              provider: "foundation",
              model: "foundation-model",
              system: "system",
              messages: [{ role: "user", content: input.command.text }],
              tools: [],
            },
          } as never,
          {
            type: "assistant/message",
            turn,
            step: index,
            requestId,
            text: tool ? "" : `done: ${input.command.text}`,
            toolCalls: tool
              ? [{ id: `call-${index}`, name: "look", input: {} }]
              : [],
          } as never,
        );
        if (tool) {
          const occurrenceId = `tool:${turn}:${index}:0`;
          effects.push(`tool:${runId}:${occurrenceId}`);
          await persist(
            {
              type: "tool/call",
              turn,
              step: index,
              occurrenceId,
              name: "look",
              input: {},
            } as never,
            {
              type: "tool/result",
              turn,
              step: index,
              occurrenceId,
              name: "look",
              content: "seen",
              isError: false,
              status: "completed",
            } as never,
          );
        }
        await persist({
          type: "step/end",
          turn,
          step: index,
          outcome: "completed",
        } as never);
      };

      let turn: number;
      let closedSteps: number;
      if (input.resume) {
        const start = input.journal.find(
          (event) => event.type === "turn/start",
        );
        if (start?.type !== "turn/start") throw new Error("nothing to resume");
        turn = start.turn;
        closedSteps = input.journal.filter(
          (event) => event.type === "step/end",
        ).length;
      } else {
        const log = await new SessionEventLog(storage).read(sessionId);
        turn = log.filter((event) => event.type === "turn/start").length + 1;
        await persist(
          { type: "turn/start", turn } as never,
          {
            type: "user/message",
            turn,
            step: 1,
            messageId: `m-${runId}`,
            text: input.command.text,
          } as never,
        );
        closedSteps = 0;
      }
      const steps = options.slow[runId] ?? 1;
      for (let index = closedSteps + 1; index <= steps; index += 1) {
        if (index > 1) {
          // The step boundary: what the loop asks before it goes on.
          const boundary = gateFor(`${runId}:${index}`);
          boundary.arrive();
          await boundary.wait();
          const waiting = await authority.userMessageWaiting(runId);
          if (waiting === "park") throw new BotTurnParkedError([]);
          if (waiting === "yield") break;
        }
        await step(turn, index, index < steps);
      }
      await persist({ type: "turn/end", turn, outcome: "completed" } as never);
      const events = await new SessionEventLog(storage).readRange(
        sessionId,
        input.resume
          ? (input.journal[0]?.seq ?? input.cursor.nextSeq)
          : input.cursor.nextSeq,
        seq,
      );
      return { runId, text: `done: ${input.command.text}`, events };
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
    runSettled: (runId) => {
      settled.push(runId);
      return Promise.resolve();
    },
  };

  const authority = new BotDurableAuthority<undefined>({
    state: { storage } as unknown as DurableObjectState,
    codec,
    hooks,
    ...(options.kickDriver === undefined
      ? {}
      : { kickDriver: options.kickDriver }),
  });
  return {
    authority,
    effects,
    observed,
    settled,
    boundary: (runId: string, step: number): Gate => {
      const found = gateFor(`${runId}:${step}`);
      return { reached: found.reached, open: found.open };
    },
  };
}

function storedRun(
  storage: MemoryStorage,
  runId: string,
): StoredRunV1<undefined> {
  return codec.require(storage.values.get(`run:${runId}`));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

describe("a person's message during a Routine", () => {
  test("runs before the Routine finishes, and the Routine resumes where it parked", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "fire-1": 3 } });

    const firing = probe.authority.run(routine("fire-1"));
    await probe.boundary("fire-1", 2).reached;
    const admitted = storedRun(storage, "fire-1");

    await probe.authority.admit(
      command("msg-1", "Can you remember that my wife is Becky"),
    );
    expect(storedRun(storage, "msg-1").phase).toBe("queued");
    expect(await probe.authority.userMessageWaiting("fire-1")).toBe("park");

    probe.boundary("fire-1", 2).open();
    await probe.boundary("fire-1", 3).reached;
    // The person's Turn ran and settled while the Routine was parked.
    expect(probe.settled).toEqual(["msg-1"]);
    expect(storedRun(storage, "msg-1").status).toBe("completed");
    expect(await probe.authority.readParkedRunId()).toBeUndefined();
    probe.boundary("fire-1", 3).open();

    const done = await firing;
    expect(done.text).toBe("done: triage the inbox");
    expect(probe.settled).toEqual(["msg-1", "fire-1"]);

    // The person's message ran as a Turn of its own, in the conversation,
    // carrying only what they said.
    const person = probe.observed.find(
      (input) => input.command.runId === "msg-1",
    );
    expect(person?.command.text).toBe("Can you remember that my wife is Becky");
    expect(person?.command.sessionId).toBe(CONVERSATION);
    expect(person?.resume).toBe(false);

    // The Routine resumed rather than restarting, and nothing it did ran
    // twice: one model call per step, and its one tool call once.
    expect(
      probe.observed
        .filter((input) => input.command.runId === "fire-1")
        .map((input) => input.resume),
    ).toEqual([false, true]);
    expect(duplicates(probe.effects)).toEqual([]);
    expect(probe.effects.filter((effect) => effect.includes("fire-1"))).toEqual(
      [
        "model:request-fire-1-1",
        "tool:fire-1:tool:1:1:0",
        "model:request-fire-1-2",
        "tool:fire-1:tool:1:2:0",
        "model:request-fire-1-3",
      ],
    );

    const resumed = probe.observed.find(
      (input) => input.command.runId === "fire-1" && input.resume,
    );
    expect(resumed?.command.turnType).toBe("automation");
    expect(resumed?.compositionGenerationId).toBe(
      admitted.compositionGenerationId,
    );
    const settledRun = storedRun(storage, "fire-1");
    expect(settledRun).toMatchObject({
      status: "completed",
      compositionGenerationId: admitted.compositionGenerationId,
      admission: { turnType: "automation" },
    });
    const log = await new SessionEventLog(storage).read("routine:triage");
    expect(log.filter((event) => event.type === "turn/start")).toHaveLength(1);
    expect(log.filter((event) => event.type === "turn/end")).toHaveLength(1);
    expect(storage.values.get("active-run")).toBeUndefined();
  });

  test("is parked with no deadline, and holds its place against agent and Routine work", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, {
      slow: { "fire-1": 2, "msg-1": 2 },
    });

    const firing = probe.authority.run(routine("fire-1"));
    await probe.boundary("fire-1", 2).reached;
    await probe.authority.admit(command("msg-1", "hello"));
    probe.boundary("fire-1", 2).open();
    await probe.boundary("msg-1", 2).reached;

    expect(storedRun(storage, "fire-1").phase).toBe("parked");
    expect(await probe.authority.readParkedRunId()).toBe("fire-1");
    // Parked is not running: nothing will settle it as stale while it waits.
    expect(storage.values.get(repairRunKey("fire-1"))).toBeUndefined();
    expect(storage.alarmAt).toBeDefined();

    // Agent work waits behind the parked run, and another Routine firing is
    // refused rather than jumping in.
    const agent = probe.authority.run(
      command("agent-1", "a question", {
        turnType: "agent",
        lane: "agent",
        sessionId: "user-1:elsewhere",
      }),
    );
    await settle();
    expect(storedRun(storage, "agent-1").phase).toBe("queued");
    await expect(probe.authority.run(routine("fire-2"))).rejects.toThrow(
      /bot already has an active run/,
    );

    probe.boundary("msg-1", 2).open();
    await firing;
    await agent;
    expect(probe.settled).toEqual(["msg-1", "fire-1", "agent-1"]);
  });

  test("parks again for each message, and still finishes", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "fire-1": 3 } });

    const firing = probe.authority.run(routine("fire-1"));
    await probe.boundary("fire-1", 2).reached;
    await probe.authority.admit(command("msg-1", "one"));
    probe.boundary("fire-1", 2).open();
    await probe.boundary("fire-1", 3).reached;
    await probe.authority.admit(command("msg-2", "two"));
    probe.boundary("fire-1", 3).open();

    const done = await firing;
    expect(done.text).toBe("done: triage the inbox");
    expect(probe.settled).toEqual(["msg-1", "msg-2", "fire-1"]);
    expect(
      probe.observed
        .filter((input) => input.command.runId === "fire-1")
        .map((input) => input.resume),
    ).toEqual([false, true, true]);
    expect(duplicates(probe.effects)).toEqual([]);
    expect(storedRun(storage, "fire-1").status).toBe("completed");
  });

  test("a parked run survives an eviction and resumes from the alarm", async () => {
    const storage = new MemoryStorage();
    const before = createProbe(storage, {
      slow: { "fire-1": 2 },
      kickDriver: false,
    });
    await before.authority.admit(routine("fire-1"));
    const firstPass = before.authority.alarm();
    await before.boundary("fire-1", 2).reached;
    await before.authority.admit(command("msg-1", "hello"));
    before.boundary("fire-1", 2).open();
    await firstPass;
    expect(storedRun(storage, "fire-1").phase).toBe("parked");
    expect(storedRun(storage, "msg-1").phase).toBe("queued");
    expect(storage.alarmAt).toBeDefined();

    // A fresh object over the same storage has nothing in memory but the
    // durable record.
    const after = createProbe(storage, {
      slow: { "fire-1": 2 },
      kickDriver: false,
    });
    await after.authority.alarm();
    expect(storedRun(storage, "msg-1").status).toBe("completed");
    expect(storedRun(storage, "fire-1").status).toBe("running");
    // The resume asks again at the boundary it parked on.
    after.boundary("fire-1", 2).open();
    await after.authority.alarm();
    expect(storedRun(storage, "fire-1").status).toBe("completed");

    expect(after.observed.map((input) => input.command.runId)).toEqual([
      "msg-1",
      "fire-1",
    ]);
    expect(after.observed[1]?.resume).toBe(true);
    expect(duplicates([...before.effects, ...after.effects])).toEqual([]);
    expect(await after.authority.readParkedRunId()).toBeUndefined();
  });
});

describe("Turns that are not the person's", () => {
  test("an agent-lane Turn in a Session of its own parks the same way", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "agent-1": 2 } });

    const agent = probe.authority.run(
      command("agent-1", "a question", {
        turnType: "agent",
        lane: "agent",
        sessionId: "user-1:elsewhere",
      }),
    );
    await probe.boundary("agent-1", 2).reached;
    await probe.authority.admit(command("msg-1", "hello"));
    expect(await probe.authority.userMessageWaiting("agent-1")).toBe("park");
    probe.boundary("agent-1", 2).open();

    expect((await agent).text).toBe("done: a question");
    expect(probe.settled).toEqual(["msg-1", "agent-1"]);
    expect(duplicates(probe.effects)).toEqual([]);
  });

  test("an agent-lane Turn in the conversation yields rather than parks", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "handoff-1": 2 } });

    const handoff = probe.authority.run(
      command("handoff-1", "the delegated work", {
        turnType: "agent",
        lane: "agent",
      }),
    );
    await probe.boundary("handoff-1", 2).reached;
    await probe.authority.admit(command("msg-1", "hello"));
    expect(await probe.authority.userMessageWaiting("handoff-1")).toBe("yield");
    probe.boundary("handoff-1", 2).open();
    await handoff;
    await settle();

    expect(probe.settled).toEqual(["handoff-1", "msg-1"]);
    expect(storedRun(storage, "handoff-1").status).toBe("completed");
    expect(storage.values.get(PARKED_RUN_KEY)).toBeUndefined();
  });

  test("the person's own Turn still yields, wherever it runs", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "msg-1": 2 } });

    const first = probe.authority.run(command("msg-1", "first"));
    await probe.boundary("msg-1", 2).reached;
    await probe.authority.admit(command("msg-2", "second"));
    expect(await probe.authority.userMessageWaiting("msg-1")).toBe("yield");
    probe.boundary("msg-1", 2).open();
    await first;
    await settle();
    expect(probe.settled).toEqual(["msg-1", "msg-2"]);
    expect(storage.values.get(PARKED_RUN_KEY)).toBeUndefined();
  });
});

describe("Stop on a parked Routine", () => {
  test("settles it cancelled at once, without waiting for its turn", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, {
      slow: { "fire-1": 2, "msg-1": 2 },
    });

    const firing = probe.authority.run(routine("fire-1"));
    await probe.boundary("fire-1", 2).reached;
    await probe.authority.admit(command("msg-1", "hello"));
    probe.boundary("fire-1", 2).open();
    await probe.boundary("msg-1", 2).reached;
    expect(storedRun(storage, "fire-1").phase).toBe("parked");

    // The durable intent the Stop command writes, then the settlement.
    storage.values.set("run:fire-1", {
      ...(storage.values.get("run:fire-1") as object),
      stopRequestedAt: "2026-09-27T00:01:00.000Z",
    });
    await probe.authority.settleStoppedParkedRun("fire-1");

    expect(storedRun(storage, "fire-1").status).toBe("cancelled");
    expect(await probe.authority.readParkedRunId()).toBeUndefined();
    expect((await firing).text).toBe("");
    const log = await new SessionEventLog(storage).read("routine:triage");
    expect(log.at(-1)).toMatchObject({ type: "turn/end" });

    // The person's Turn is untouched by it.
    probe.boundary("msg-1", 2).open();
    await settle();
    expect(storedRun(storage, "msg-1").status).toBe("completed");
    expect(probe.observed.map((input) => input.command.runId)).toEqual([
      "fire-1",
      "msg-1",
    ]);
  });

  test("leaves a run that is not parked to the running Turn's own Stop", async () => {
    const storage = new MemoryStorage();
    const probe = createProbe(storage, { slow: { "fire-1": 2 } });
    const firing = probe.authority.run(routine("fire-1"));
    await probe.boundary("fire-1", 2).reached;
    storage.values.set("run:fire-1", {
      ...(storage.values.get("run:fire-1") as object),
      stopRequestedAt: "2026-09-27T00:01:00.000Z",
    });
    await probe.authority.settleStoppedParkedRun("fire-1");
    expect(storedRun(storage, "fire-1").status).toBe("running");
    probe.boundary("fire-1", 2).open();
    await firing;
    // Settling a run carrying a Stop intent cancels it.
    expect(storedRun(storage, "fire-1").status).toBe("cancelled");
  });
});
