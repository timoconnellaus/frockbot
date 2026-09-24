import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.js";
import {
  type SessionEvent,
  TURN_DEADLINE_MS_V1,
  validateToolOccurrenceJournal,
} from "@frockbot/core/contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { SessionEventLog } from "./session-event-log.ts";
import { BotTurnRecoveryRequiredError } from "./turn-errors.ts";
import {
  createStoredRunCodecV1,
  storedRunLaneV1,
  type StoredRunV1,
} from "./run-records.ts";
import {
  STALE_RUNNING_RUN_FAILURE_V1,
  STALE_RUNNING_RUN_GRACE_MS_V1,
} from "./run-liveness.ts";
import { failStoredRun } from "./run-terminal.ts";
import {
  MAX_PENDING_AGENT_RUNS_V1,
  MAX_PENDING_USER_RUNS_V1,
  PENDING_USER_RUN_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  REPAIR_DUE_PREFIX,
  pendingAgentRunKey,
  pendingUserRunKey,
  repairDueKey,
  repairRunKey,
} from "./storage-keys.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt: "2026-09-03T00:00:00.000Z" });
}

const identity = { userId: "user-1", botId: "primary" };

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
    sessionId: "user-1:primary",
    acceptedAt: new Date(Date.UTC(2026, 8, 3, 0, 0, clock)).toISOString(),
    text,
    ...extra,
  };
}

/** One Turn the test is holding open inside `executeTurn`. */
interface TurnHandle {
  /** Resolves once the Turn has journaled its opening events and blocked. */
  started: Promise<void>;
  /** Lets the Turn finish normally. */
  finish(): void;
  /** Ends the Turn the way an interrupted Agent loop does. */
  interrupt(reason: string): void;
}

interface Probe {
  authority: BotDurableAuthority<undefined>;
  observed: BotTurnExecutionInput<undefined>[];
  handle(runId: string): TurnHandle;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/**
 * Lets the object finish what a command already set in motion. Two HTTP
 * requests never reach a Durable Object in the same microtask, and the tests
 * that send two messages are describing two requests.
 */
async function admitted(): Promise<void> {
  // Admission now also hashes any legacy event payloads it migrates. Let the
  // Web Crypto promises and the Durable Object transaction both drain before
  // inspecting the durable queue.
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * An authority whose Package holds every Turn open until the test releases it,
 * and whose Turns end the way the Agent loop's do when they are cancelled: a
 * `turn/end` naming the opaque reason the caller passed, then a failure.
 *
 * `dispatch` decides whether a Turn journals a `model/request` before it
 * blocks.
 */
function createAuthority(
  storage: MemoryStorage,
  options: {
    dispatch?(runId: string): boolean;
    /**
     * Ends the named Turn the way the Agent loop ends one whose model stream
     * was aborted mid-flight: a journaled `model/request` with no answer, and
     * an error carrying the abort's own sentence.
     */
    uncertain?(runId: string): boolean;
    /**
     * Fails the named Turn when it is released, with the provider call it had
     * dispatched by then still unanswered.
     */
    unresolvedOnRelease?(runId: string): boolean;
    /** Fails the recovery of an evicted Turn, leaving it active and owed. */
    failRecovery?(runId: string): boolean;
    /** False admits without starting anything, as an evicted object would. */
    kickDriver?: boolean;
  } = {},
): Probe {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const handles = new Map<
    string,
    {
      started: Deferred<void>;
      settled: Deferred<{ interrupted?: string }>;
    }
  >();
  const handleFor = (runId: string) => {
    const existing = handles.get(runId);
    if (existing) return existing;
    const created = {
      started: deferred<void>(),
      settled: deferred<{ interrupted?: string }>(),
    };
    handles.set(runId, created);
    return created;
  };

  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      observed.push(input);
      const runId = input.command.runId;
      if (input.resume && options.failRecovery?.(runId)) {
        throw new BotTurnRecoveryRequiredError([]);
      }
      const turn = observed.length;
      const handle = handleFor(runId);
      let seq = input.cursor.nextSeq;
      const appended: SessionEvent[] = [];
      const persist = async (
        ...events: Omit<SessionEvent, "seq" | "timestamp">[]
      ) => {
        const stamped = events.map(
          (event) =>
            ({
              ...event,
              seq: seq++,
              timestamp: "2026-09-03T00:00:10.000Z",
            }) as SessionEvent,
        );
        appended.push(...stamped);
        await input.persistSessionEvents(input.command.sessionId, stamped);
      };
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
      const uncertain = options.uncertain?.(runId) ?? false;
      if (uncertain) {
        await persist({
          type: "model/request",
          turn,
          step: 1,
          request: {
            requestId: `request-${runId}`,
            provider: "foundation",
            model: "foundation-model",
            system: "system",
            messages: [{ role: "user", content: input.command.text }],
            tools: [],
          },
        } as never);
      } else if (options.dispatch?.(runId) ?? true) {
        await persist(
          {
            type: "model/request",
            turn,
            step: 1,
            request: {
              requestId: `request-${runId}`,
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
            step: 1,
            requestId: `request-${runId}`,
            text: `working on ${input.command.text}`,
            toolCalls: [],
          } as never,
        );
      }
      handle.started.resolve();
      const outcome = await handle.settled.promise;
      if (
        outcome.interrupted === undefined &&
        options.unresolvedOnRelease?.(runId)
      ) {
        await persist({
          type: "model/request",
          turn,
          step: 1,
          request: {
            requestId: `request-${runId}`,
            provider: "foundation",
            model: "foundation-model",
            system: "system",
            messages: [{ role: "user", content: input.command.text }],
            tools: [],
          },
        } as never);
        throw new Error(`Model request "request-${runId}" was never answered`);
      }
      if (outcome.interrupted !== undefined && uncertain) {
        throw new Error(
          `Model response outcome is uncertain after cancellation: ${outcome.interrupted}`,
        );
      }
      if (outcome.interrupted !== undefined) {
        await persist({
          type: "turn/end",
          turn,
          outcome: "cancelled",
          reason: outcome.interrupted,
        } as never);
        throw new Error(
          `Bot turn ended with outcome cancelled: ${outcome.interrupted}`,
        );
      }
      await persist({ type: "turn/end", turn, outcome: "completed" } as never);
      return { runId, text: `done: ${input.command.text}`, events: appended };
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
  };

  return {
    authority: new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks,
      ...(options.kickDriver === undefined
        ? {}
        : { kickDriver: options.kickDriver }),
    }),
    observed,
    handle: (runId) => {
      const handle = handleFor(runId);
      return {
        started: handle.started.promise,
        finish: () => handle.settled.resolve({}),
        interrupt: (reason) => handle.settled.resolve({ interrupted: reason }),
      };
    },
  };
}

function storedRun(
  storage: MemoryStorage,
  runId: string,
): StoredRunV1<undefined> {
  return codec.require(storage.values.get(`run:${runId}`));
}

function waitingUserRuns(storage: MemoryStorage): string[] {
  return [...storage.values.entries()]
    .filter(([key]) => key.startsWith(PENDING_USER_RUN_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value as string);
}

describe("a message sent while a Turn runs", () => {
  test("waits, asks the running Turn to yield, and runs next", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    expect(await probe.authority.userMessageWaiting("run-1")).toBe(false);

    const second = probe.authority.run(command("run-2", "second"));
    await admitted();
    // Durable and waiting, and the running Turn is untouched: it reads the
    // queue at its next step boundary and ends there itself.
    expect(storedRun(storage, "run-2").phase).toBe("queued");
    expect(waitingUserRuns(storage)).toEqual(["run-2"]);
    expect(storedRun(storage, "run-1").stopRequestedAt).toBeUndefined();
    expect(await probe.authority.userMessageWaiting("run-1")).toBe(true);

    probe.handle("run-1").finish();
    expect(await first).toMatchObject({ text: "done: first" });
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    expect(await second).toMatchObject({ text: "done: second" });

    expect(storedRun(storage, "run-1").status).toBe("completed");
    expect(storedRun(storage, "run-2").status).toBe("completed");
    expect(waitingUserRuns(storage)).toEqual([]);
    expect(storage.values.get("active-run")).toBeUndefined();
  });

  test("the next Turn starts from everything the one before it did", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(command("run-2", "second"));
    await admitted();
    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    await second;

    const nextInput = probe.observed.find(
      (input) => input.command.runId === "run-2",
    );
    if (!nextInput) throw new Error("the waiting Turn never ran");
    expect(nextInput.journal).toEqual([]);
    const archived = await new SessionEventLog(storage).read(
      nextInput.command.sessionId,
    );
    expect(archived.map((event) => event.type)).toContain("assistant/message");
    // Promotion recomputes where the Turn starts from the cursor, not from an
    // in-memory copy of the log.
    expect(storedRun(storage, "run-2").previousEventCount).toBe(
      nextInput.cursor.nextSeq,
    );
  });

  test("several messages run in the order they were sent", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "one"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(command("run-2", "two"));
    await admitted();
    const third = probe.authority.run(command("run-3", "three"));
    await admitted();
    expect(waitingUserRuns(storage)).toEqual(["run-2", "run-3"]);

    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-2").started;
    // The one behind it is still waiting, so this Turn yields too.
    expect(await probe.authority.userMessageWaiting("run-2")).toBe(true);
    probe.handle("run-2").finish();
    await second;
    await probe.handle("run-3").started;
    expect(await probe.authority.userMessageWaiting("run-3")).toBe(false);
    probe.handle("run-3").finish();
    await third;

    // Nobody's message is dropped: every one ran, in order.
    expect(probe.observed.map((input) => input.command.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("a replayed command replays rather than queueing twice", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const waiting = command("run-2", "second");

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(waiting);
    await admitted();
    await probe.authority.admit(waiting);
    expect(waitingUserRuns(storage)).toEqual(["run-2"]);

    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    await second;
  });

  test("refuses a message past the bounded queue", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    for (let index = 0; index < MAX_PENDING_USER_RUNS_V1; index += 1) {
      const runId = `queued-${index}`;
      storage.values.set(
        pendingUserRunKey(
          new Date(Date.UTC(2026, 8, 3, 1, 0, index)).toISOString(),
          runId,
        ),
        runId,
      );
    }

    await expect(
      probe.authority.run(command("run-past-bound", "one more")),
    ).rejects.toThrow(/message queue is full \(32 messages\)/);

    probe.handle("run-1").finish();
    await first;
  });
});

describe("only a Turn on the person's own lane yields", () => {
  test("a Turn answering another Bot finishes its job first", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const agent = probe.authority.run(
      command("run-agent", "question", { turnType: "agent" }),
    );
    await probe.handle("run-agent").started;
    const person = probe.authority.run(command("run-user", "hello"));
    await admitted();

    expect(await probe.authority.userMessageWaiting("run-agent")).toBe(false);
    // A run that is not the active one never yields either.
    expect(await probe.authority.userMessageWaiting("run-user")).toBe(false);

    probe.handle("run-agent").finish();
    await agent;
    await probe.handle("run-user").started;
    probe.handle("run-user").finish();
    await person;
  });

  test("a Routine firing is refused while anything runs or waits", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;

    await expect(
      probe.authority.run(
        command("run-2", "firing", { turnType: "automation" }),
      ),
    ).rejects.toThrow(/bot already has an active run/);

    probe.handle("run-1").finish();
    await first;
  });

  test("the lane a Turn was admitted on is durable", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    probe.handle("run-1").finish();
    await first;

    // A chat Turn's lane is what its recorded turn type already says, so no
    // stored byte changed to carry it.
    const chat = storedRun(storage, "run-1");
    expect(chat.admission).toBeUndefined();
    expect(storedRunLaneV1(chat)).toBe("user");
    expect(
      storedRunLaneV1({
        admission: { schemaVersion: 1, turnType: "automation" },
      }),
    ).toBe("background");
  });
});

describe("the agent lane", () => {
  test("queues behind the active Turn without making it yield", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "person"));
    await probe.handle("run-1").started;

    const agent = probe.authority.run(
      command("run-agent", "question", {
        turnType: "agent",
        origin: {
          kind: "bot",
          fromBotId: "researcher",
          fromBotName: "Researcher",
          messageId: "message-1",
        },
      }),
    );
    await admitted();
    expect(await probe.authority.userMessageWaiting("run-1")).toBe(false);
    expect(storedRun(storage, "run-agent")).toMatchObject({
      phase: "queued",
      admission: { turnType: "agent" },
    });
    expect(storedRunLaneV1(storedRun(storage, "run-agent"))).toBe("agent");

    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-agent").started;
    probe.handle("run-agent").finish();
    expect(await agent).toMatchObject({ text: "done: question" });
  });

  test("runs queued agent Turns FIFO", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const active = probe.authority.run(command("run-1", "person"));
    await probe.handle("run-1").started;

    const firstAgent = probe.authority.run(
      command("run-agent-1", "first agent", { turnType: "agent" }),
    );
    await admitted();
    const secondAgent = probe.authority.run(
      command("run-agent-2", "second agent", { turnType: "agent" }),
    );
    await admitted();

    probe.handle("run-1").finish();
    await active;
    await probe.handle("run-agent-1").started;
    expect(probe.observed.map(({ command }) => command.runId)).toEqual([
      "run-1",
      "run-agent-1",
    ]);
    probe.handle("run-agent-1").finish();
    await firstAgent;

    await probe.handle("run-agent-2").started;
    probe.handle("run-agent-2").finish();
    await secondAgent;
    expect(probe.observed.map(({ command }) => command.runId)).toEqual([
      "run-1",
      "run-agent-1",
      "run-agent-2",
    ]);
  });

  test("gives a queued User Turn priority over queued agent work", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const active = probe.authority.run(command("run-1", "person"));
    await probe.handle("run-1").started;
    const agent = probe.authority.run(
      command("run-agent", "agent", { turnType: "agent" }),
    );
    await admitted();

    const user = probe.authority.run(command("run-user", "next message"));
    await admitted();
    probe.handle("run-1").finish();
    await active;
    await probe.handle("run-user").started;
    expect(probe.observed.map(({ command }) => command.runId)).toEqual([
      "run-1",
      "run-user",
    ]);
    probe.handle("run-user").finish();
    await user;

    await probe.handle("run-agent").started;
    probe.handle("run-agent").finish();
    await agent;
    expect(probe.observed.map(({ command }) => command.runId)).toEqual([
      "run-1",
      "run-user",
      "run-agent",
    ]);
  });

  // Agent work used to be refused while a Turn sat parked on a reconciliation
  // only a person could perform. An unanswered model request settles its own
  // Turn instead, so the Bot is free the moment that Turn stops.
  test("admits agent work once an unanswered Turn has settled", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, {
      unresolvedOnRelease: (runId) => runId === "run-1",
    });
    const active = probe.authority.run(command("run-1", "person"));
    await probe.handle("run-1").started;
    probe.handle("run-1").finish();
    await active.catch(() => undefined);
    expect(storedRun(storage, "run-1").status).toBe("failed");

    const agent = probe.authority.run(
      command("run-agent", "agent", { turnType: "agent" }),
    );
    await probe.handle("run-agent").started;
    probe.handle("run-agent").finish();
    await agent;

    expect(storedRun(storage, "run-agent").status).toBe("completed");
  });

  test("refuses admission when the Bot's bounded agent queue is full", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "person"));
    await probe.handle("run-1").started;
    for (let index = 0; index < MAX_PENDING_AGENT_RUNS_V1; index += 1) {
      const runId = `queued-${index}`;
      storage.values.set(
        pendingAgentRunKey(
          new Date(Date.UTC(2026, 8, 3, 1, 0, index)).toISOString(),
          runId,
        ),
        runId,
      );
    }

    await expect(
      probe.authority.run(
        command("run-past-bound", "question", { turnType: "agent" }),
      ),
    ).rejects.toThrow(/agent queue is full \(32 Turns\)/);

    probe.handle("run-1").finish();
    await first;
  });
});

describe("eviction between the two Turns", () => {
  /**
   * Exactly what the object holds at the moment between the first Turn
   * settling and the waiting one starting: no active run, a queued run record,
   * and the queue entry naming it. Nothing else survives an eviction, so
   * nothing else is given to the object that comes back.
   */
  async function evictedBetweenTurns(): Promise<MemoryStorage> {
    // The object promotes the queued Turn as soon as the first settles, racing
    // the test's own `await first`. What it held at that promotion is the
    // moment between the two, whichever side of the race wins.
    const evicted = new MemoryStorage();
    class PromotionWatch extends MemoryStorage {
      override put(
        key: string | Record<string, unknown>,
        value?: unknown,
      ): Promise<void> {
        const activates =
          typeof key === "string"
            ? key === "active-run" && value === "run-2"
            : key["active-run"] === "run-2";
        if (activates && evicted.values.size === 0) {
          for (const [entry, item] of this.values) {
            evicted.values.set(entry, structuredClone(item));
          }
        }
        return super.put(key, value);
      }
    }
    const probe = createAuthority(new PromotionWatch());
    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(command("run-2", "second"));
    await admitted();
    probe.handle("run-1").finish();
    await first.catch(() => undefined);
    await probe.handle("run-2").started;
    // The caller that was waiting for the queued Turn is gone with the object.
    second.catch(() => undefined);
    return evicted;
  }

  test("a reconstructed object starts the queued Turn exactly once", async () => {
    const storage = await evictedBetweenTurns();
    expect(waitingUserRuns(storage)).toEqual(["run-2"]);
    expect(storage.values.get("active-run")).toBeUndefined();
    expect(storedRun(storage, "run-1").status).toBe("completed");
    expect(storedRun(storage, "run-2").phase).toBe("queued");

    const restarted = createAuthority(storage);
    const resumed = restarted.authority.recoverActiveRun();
    await restarted.handle("run-2").started;
    restarted.handle("run-2").finish();
    await resumed;

    expect(restarted.observed.map((input) => input.command.runId)).toEqual([
      "run-2",
    ]);
    expect(storedRun(storage, "run-2").status).toBe("completed");
    // A second recovery pass starts nothing: the queue is empty.
    await restarted.authority.recoverActiveRun();
    expect(restarted.observed).toHaveLength(1);
  });
});

describe("a durable log left inside a Turn", () => {
  test("a later Turn starts after an open Turn without renumbering it", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    // An open Turn with no run left to close it. The next Turn's journal does
    // not include it, so admission does not rewrite the archive to insert a
    // `turn/end` and give everything after a new sequence number.
    await log.rewrite("user-1:primary", [
      {
        type: "session/created",
        createdAt: "2026-09-03T00:00:00.000Z",
        seq: 0,
        timestamp: "2026-09-03T00:00:00.000Z",
      },
      {
        type: "turn/start",
        turn: 1,
        seq: 1,
        timestamp: "2026-09-03T00:00:01.000Z",
      },
    ]);
    const probe = createAuthority(storage);

    const run = probe.authority.run(command("run-1", "hello"));
    await probe.handle("run-1").started;
    probe.handle("run-1").finish();
    await run;

    const events = await log.read("user-1:primary");
    expect(events[1]).toMatchObject({ type: "turn/start", turn: 1, seq: 1 });
    expect(events.at(-1)).toMatchObject({ type: "turn/end" });
    expect(storedRun(storage, "run-1").status).toBe("completed");
  });

  test("a later Turn starts when an older Turn was left open behind it", async () => {
    const storage = new MemoryStorage();
    const log = new SessionEventLog(storage);
    // A refused message journaled its own closed Turn behind the abandoned
    // one. Closing that abandoned Turn would mean inserting events and
    // renumbering the suffix. The next Turn's journal is only its own run,
    // so it does not revalidate the archive and the original sequences stay.
    await log.rewrite("user-1:primary", [
      {
        type: "session/created",
        createdAt: "2026-09-03T00:00:00.000Z",
        seq: 0,
        timestamp: "2026-09-03T00:00:00.000Z",
      },
      {
        type: "turn/start",
        turn: 1,
        seq: 1,
        timestamp: "2026-09-03T00:00:01.000Z",
      },
      {
        type: "turn/start",
        turn: 2,
        seq: 2,
        timestamp: "2026-09-03T00:00:02.000Z",
      },
      {
        type: "turn/end",
        turn: 2,
        outcome: "model-error",
        reason: "turn 2 started while turn 1 is open",
        seq: 3,
        timestamp: "2026-09-03T00:00:03.000Z",
      },
    ]);
    const probe = createAuthority(storage);

    const run = probe.authority.run(command("run-1", "hello"));
    await probe.handle("run-1").started;
    probe.handle("run-1").finish();
    await run;

    const events = await log.read("user-1:primary");
    expect(events[1]).toMatchObject({ type: "turn/start", turn: 1, seq: 1 });
    expect(events[2]).toMatchObject({ type: "turn/start", turn: 2, seq: 2 });
    expect(events[3]).toMatchObject({ type: "turn/end", turn: 2, seq: 3 });
    expect(storedRun(storage, "run-1").status).toBe("completed");
    expect(storedRun(storage, "run-1").previousEventCount).toBe(4);
  });
});

describe("a failing recovery of an older Turn", () => {
  test("does not swallow the message the User just sent", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    // Evicted mid-Turn: run-1 stays active and durable, and the object that
    // comes back recovers it — badly.
    const restarted = createAuthority(storage, {
      failRecovery: (runId) => runId === "run-1",
    });
    const second = restarted.authority
      .run(command("run-2", "second"))
      .catch(() => undefined);
    await admitted();

    // The new message is durable regardless of what happened to the old Turn.
    // Before this, the recovery's own error threw out of `run()` before
    // admission was ever attempted and the message was simply gone.
    expect(storedRun(storage, "run-2").runId).toBe("run-2");
    expect(storedRun(storage, "run-2").input).toBe("second");
    probe.handle("run-1").finish();
    await first.catch(() => undefined);
    restarted.handle("run-2").finish();
    await second;
  });
});

describe("the run admission fence index", () => {
  test("ages the oldest entry out rather than refusing the operation", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    for (let index = 0; index < 300; index += 1) {
      await probe.authority.fenceRunAdmission(identity, `fence-${index}`);
    }
    const fences = storage.values.get("run-admission-fences") as string[];
    expect(fences.length).toBeLessThanOrEqual(256);
    // The newest fence is the one that still matters; the oldest aged out.
    expect(fences.at(-1)).toBe("fence-299");
    expect(fences).not.toContain("fence-0");
  });
});

describe("a Turn queued behind a run whose model never answered", () => {
  test("is started by that run's own settlement", async () => {
    const storage = new MemoryStorage();
    // The second message waits behind the first, whose provider call is then
    // never answered.
    const probe = createAuthority(storage, {
      dispatch: () => false,
      unresolvedOnRelease: (runId) => runId === "run-1",
    });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(command("run-2", "second"));
    await admitted();
    probe.handle("run-1").finish();
    await first.catch(() => undefined);

    // Nothing is parked, so the queued Turn is promoted rather than refused.
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    await second;

    expect(storedRun(storage, "run-1").status).toBe("failed");
    expect(storedRun(storage, "run-2").status).toBe("completed");
    expect(waitingUserRuns(storage)).toEqual([]);
  });
});

describe("a Stop while the model is streaming", () => {
  test("a stopped Turn settles cancelled and the next message is admitted", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, { uncertain: () => true });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    // What an authenticated Stop writes before it signals the Agent.
    const stopped = storedRun(storage, "run-1");
    storage.values.set("run:run-1", {
      ...stopped,
      stopRequestedAt: "2026-09-03T00:00:05.000Z",
    });
    probe.handle("run-1").interrupt("stopped by an authenticated Stop command");
    await first.catch(() => undefined);

    expect(storedRun(storage, "run-1").status).toBe("cancelled");
    expect(storage.values.get("active-run")).toBeUndefined();

    // And the Bot takes the next message straight away, with no
    // reconciliation standing between the User and their Bot.
    const next = probe.authority.run(command("run-2", "second"));
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    expect((await next).text).toBe("done: second");
  });
});

describe("a discarded Turn never crashes the object", () => {
  test("the long-lived caller is answered with the cancelled run, not a throw", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, { uncertain: () => true });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const stopped = storedRun(storage, "run-1");
    storage.values.set("run:run-1", {
      ...stopped,
      stopRequestedAt: "2026-09-03T00:00:05.000Z",
    });
    probe.handle("run-1").interrupt("agent cancelled by user");

    // The composer is still holding this request open when Stop is pressed. It
    // used to be answered with a 500 and a red console error while the UI
    // beside it said "You stopped this." A Turn the person stopped on purpose
    // is an ordinary outcome and settles as one.
    const settled = await first;
    expect(settled.runId).toBe("run-1");
    expect(settled.text).toBe("");
    expect(storedRun(storage, "run-1").status).toBe("cancelled");
    expect(storage.values.get("active-run")).toBeUndefined();
  });

  test("recovery settles a stopped Turn instead of re-entering it", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, { uncertain: () => true });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const running = storedRun(storage, "run-1");
    storage.values.set("run:run-1", {
      ...running,
      stopRequestedAt: "2026-09-03T00:00:05.000Z",
    });
    // The object is evicted with the Stop durable and the Turn still active:
    // exactly the state the recovery alarm wakes up to.
    first.catch(() => undefined);

    const evicted = createAuthority(storage, { uncertain: () => true });
    await expect(evicted.authority.alarm()).resolves.toBeUndefined();

    // Re-entering it is what took the dev Worker down: the run resumed, reached
    // "Model response outcome is uncertain after cancellation", and the alarm
    // had nobody to hand the rejection to. There is nothing to recover — the
    // User already said to throw it away.
    expect(evicted.observed).toEqual([]);
    expect(storedRun(storage, "run-1").status).toBe("cancelled");
    expect(storage.values.get("active-run")).toBeUndefined();
  });

  test("an alarm records a recovery failure instead of rejecting", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, { failRecovery: () => true });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    first.catch(() => undefined);

    // A recovery that cannot run the Turn is a durable fact, not a fault of the
    // alarm: an alarm has no caller, so anything it lets escape is an uncaught
    // exception in the object — one of the ways the dev Worker died.
    const evicted = createAuthority(storage, { failRecovery: () => true });
    await expect(evicted.authority.alarm()).resolves.toBeUndefined();
    // And the object still has a deadline, so the next firing tries again.
    expect(storage.alarmAt).toBeGreaterThan(0);
  });
});

describe("a Turn whose provider call was never answered", () => {
  test("answers its caller with the run it settled rather than throwing", async () => {
    const storage = new MemoryStorage();
    // This used to park on a provider outcome only a User could retrieve, and
    // the Resolve Turn button existed to abandon it. Nothing parks: the run
    // settles itself, and its caller is handed that settlement.
    const probe = createAuthority(storage, {
      dispatch: () => false,
      unresolvedOnRelease: () => true,
    });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    probe.handle("run-1").finish();
    const completion = await first;

    expect(completion.runId).toBe("run-1");
    const settled = storedRun(storage, "run-1");
    expect(settled.status).toBe("failed");
    expect(settled.failure).toContain("was never answered");
    expect(storage.values.get("active-run")).toBeUndefined();
  });
});

describe("a message that waits longer than the Turn deadline", () => {
  /** An acceptance time whose admission-based repair deadline has passed. */
  function pastRepairDeadline(offsetMs = 0): string {
    return new Date(
      Date.now() -
        TURN_DEADLINE_MS_V1 -
        STALE_RUNNING_RUN_GRACE_MS_V1 -
        60_000 +
        offsetMs,
    ).toISOString();
  }

  function repairDueRuns(storage: MemoryStorage): string[] {
    return [...storage.values.entries()]
      .filter(([key]) => key.startsWith(REPAIR_DUE_PREFIX))
      .map(([, value]) => value as string);
  }

  test("is not settled while it waits, and runs once the Turn ahead settles", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(
      command("run-1", "first", { acceptedAt: pastRepairDeadline() }),
    );
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "second", { acceptedAt: pastRepairDeadline(1_000) }),
    );
    const third = probe.authority.run(
      command("run-3", "third", { acceptedAt: pastRepairDeadline(2_000) }),
    );
    await admitted();
    expect(waitingUserRuns(storage)).toEqual(["run-2", "run-3"]);
    // Waiting is not running: the queue owes these Turns their terminal
    // state, so nothing counts down on them yet.
    expect(repairDueRuns(storage)).toEqual(["run-1"]);

    // The alarm fires, and fires again, while the first Turn holds the Bot.
    await probe.authority.alarm();
    await probe.authority.alarm();
    expect(storedRun(storage, "run-2")).toMatchObject({
      status: "running",
      phase: "queued",
    });
    expect(storedRun(storage, "run-3")).toMatchObject({
      status: "running",
      phase: "queued",
    });
    expect(waitingUserRuns(storage)).toEqual(["run-2", "run-3"]);

    const promotedFrom = Date.now();
    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-2").started;
    // Its clock starts when it does, as the loop's own deadline does.
    expect(storage.values.get(repairRunKey("run-2"))).toBeGreaterThanOrEqual(
      promotedFrom + TURN_DEADLINE_MS_V1 + STALE_RUNNING_RUN_GRACE_MS_V1,
    );
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    probe.handle("run-2").finish();
    expect(await second).toMatchObject({ text: "done: second" });
    await probe.handle("run-3").started;
    probe.handle("run-3").finish();
    expect(await third).toMatchObject({ text: "done: third" });

    expect(probe.observed.map((input) => input.command.runId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
    expect(waitingUserRuns(storage)).toEqual([]);
    expect(repairDueRuns(storage)).toEqual([]);
  });

  test("a repair entry on a waiting Turn is dropped, not acted on", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "second", { acceptedAt: pastRepairDeadline() }),
    );
    await admitted();
    const due = Date.now() - 1_000;
    await storage.put({
      [repairRunKey("run-2")]: due,
      [repairDueKey(due, "run-2")]: "run-2",
    });

    await probe.authority.alarm();
    expect(storedRun(storage, "run-2")).toMatchObject({
      status: "running",
      phase: "queued",
    });
    expect(storage.values.has(repairRunKey("run-2"))).toBe(false);
    expect(repairDueRuns(storage)).not.toContain("run-2");
    expect(storage.alarmAt).toBeGreaterThan(Date.now());

    probe.handle("run-1").finish();
    await first;
    await probe.handle("run-2").started;
    probe.handle("run-2").finish();
    expect(await second).toMatchObject({ text: "done: second" });
  });

  test("a queue entry naming a settled Turn does not hold the Turns behind it", async () => {
    const storage = new MemoryStorage();
    const admitting = createAuthority(storage, { kickDriver: false });
    await admitting.authority.admit(command("run-1", "first"));
    await admitting.authority.admit(command("run-2", "second"));
    await admitting.authority.admit(command("run-3", "third"));
    expect(waitingUserRuns(storage)).toEqual(["run-2", "run-3"]);

    // What the repair used to leave behind: the Turn ahead settled, and the
    // waiting Turn failed in the queue with its entry still at the head.
    const active = storage.values.get("run:run-1") as Record<string, unknown>;
    storage.values.set("run:run-1", {
      ...active,
      status: "completed",
      responseText: "done: first",
    });
    storage.values.delete("active-run");
    const waiting = storage.values.get("run:run-2") as Record<string, unknown>;
    storage.values.set("run:run-2", {
      ...waiting,
      status: "failed",
      failure: STALE_RUNNING_RUN_FAILURE_V1,
    });

    const restarted = createAuthority(storage);
    const alarm = restarted.authority.alarm();
    await Promise.race([restarted.handle("run-3").started, alarm]);
    restarted.handle("run-3").finish();
    await alarm;

    expect(restarted.observed.map((input) => input.command.runId)).toEqual([
      "run-3",
    ]);
    expect(storedRun(storage, "run-2").status).toBe("failed");
    expect(storedRun(storage, "run-3").status).toBe("completed");
    expect(waitingUserRuns(storage)).toEqual([]);
  });

  test("a Turn settled while it waits leaves the queue", async () => {
    const storage = new MemoryStorage();
    const admitting = createAuthority(storage, { kickDriver: false });
    await admitting.authority.admit(command("run-1", "first"));
    await admitting.authority.admit(command("run-2", "second"));
    expect(waitingUserRuns(storage)).toEqual(["run-2"]);

    await storage.transaction((transaction) =>
      failStoredRun(
        codec,
        transaction,
        {
          run: "run:run-2",
          activeRun: "active-run",
          latestEvents: "latest-events",
          notificationPrefix: "notification:",
        },
        "run-2",
        [],
        [],
        STALE_RUNNING_RUN_FAILURE_V1,
      ),
    );

    expect(storedRun(storage, "run-2").status).toBe("failed");
    expect(waitingUserRuns(storage)).toEqual([]);
    expect(storage.values.get("active-run")).toBe("run-1");
  });
});

describe("an active Turn running past its repair deadline", () => {
  test("keeps the alarm at the recovery interval rather than in the past", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    // A Turn recovery restarted late in its life, or one that waited in the
    // queue before the deadline ran from its promotion: executing, active, and
    // past the due time its repair entry names.
    const first = probe.authority.run(
      command("run-1", "first", {
        acceptedAt: new Date(
          Date.now() -
            TURN_DEADLINE_MS_V1 -
            STALE_RUNNING_RUN_GRACE_MS_V1 -
            1_000,
        ).toISOString(),
      }),
    );
    await probe.handle("run-1").started;
    expect(storage.values.get(repairRunKey("run-1"))).toBeLessThan(Date.now());

    const firedAt = Date.now();
    await probe.authority.alarm();
    // The repair skips the active Turn, so an alarm armed on its due time
    // fired straight back into the same skip until the Turn settled.
    expect(storage.alarmAt).toBeGreaterThanOrEqual(
      firedAt + RECOVERY_ALARM_DELAY_MS,
    );
    expect(storedRun(storage, "run-1").status).toBe("running");

    probe.handle("run-1").finish();
    expect(await first).toMatchObject({ text: "done: first" });
  });
});
