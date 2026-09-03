import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  SUPERSEDED_TURN_REASON_V1,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  createStoredRunCodecV1,
  storedRunLaneV1,
  type StoredRunV1,
} from "./run-records.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "0.0.1",
        manifest: { id: "shell", version: "0.0.1" },
      },
    ],
    { createdAt: "2026-09-03T00:00:00.000Z" },
  );
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
  interrupts: { runId: string; reason: string }[];
  supersededRecordRuns: string[];
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
function admitted(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
 * blocks. That event is the whole of what makes a Turn interruptible: a Turn
 * that has not reached its first durable checkpoint is left to finish.
 */
function createAuthority(
  storage: MemoryStorage,
  options: { dispatch?(runId: string): boolean } = {},
): Probe {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const interrupts: { runId: string; reason: string }[] = [];
  const supersededRecordRuns: string[] = [];
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
      const turn = observed.length;
      const handle = handleFor(runId);
      let seq = input.previousEvents.length;
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
      if (options.dispatch?.(runId) ?? true) {
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
    interruptTurn: (runId, reason) => {
      interrupts.push({ runId, reason });
      handleFor(runId).settled.resolve({ interrupted: reason });
    },
    supersededRecords: ({ run }) => {
      supersededRecordRuns.push(run.runId);
      return Promise.resolve({
        [`superseded-note:${run.runId}`]: { runId: run.runId },
      });
    },
  };

  return {
    authority: new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks,
    }),
    observed,
    interrupts,
    supersededRecordRuns,
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

function turnEndOf(run: StoredRunV1<undefined>) {
  return run.events.findLast((event) => event.type === "turn/end");
}

describe("a user message supersedes the running Turn", () => {
  test("the running Turn terminalizes superseded and the new one runs", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;

    const second = probe.authority.run(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    // The new Turn is durable before anything is acknowledged, and it is
    // waiting rather than running.
    await probe.handle("run-2").started.then(
      () => undefined,
      () => undefined,
    );
    await first;
    probe.handle("run-2").finish();
    const result = await second;

    const superseded = storedRun(storage, "run-1");
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe("run-2");
    expect(turnEndOf(superseded)).toMatchObject({
      outcome: "cancelled",
      reason: SUPERSEDED_TURN_REASON_V1,
    });
    expect(probe.interrupts).toEqual([
      { runId: "run-1", reason: SUPERSEDED_TURN_REASON_V1 },
    ]);

    const replacement = storedRun(storage, "run-2");
    expect(replacement.status).toBe("completed");
    expect(replacement.input).toBe("second");
    expect(result.text).toBe("done: second");
    expect(storage.values.get("active-run")).toBeUndefined();
    expect(storage.values.get("pending-run")).toBeUndefined();
  });

  test("the superseded Turn's history is what the next Turn starts from", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    await first;
    probe.handle("run-2").finish();
    await second;

    // The replacement was handed everything the superseded Turn made durable:
    // what it said, and the fact that it ended cancelled and why.
    const replacementInput = probe.observed.find(
      (input) => input.command.runId === "run-2",
    );
    if (!replacementInput) throw new Error("the replacement Turn never ran");
    const kinds = replacementInput.previousEvents.map((event) => event.type);
    expect(kinds).toContain("assistant/message");
    expect(kinds).toContain("turn/end");
    // And it starts *after* them: `previousEventCount` is recomputed when the
    // queued Turn is promoted, not when it was admitted.
    expect(storedRun(storage, "run-2").previousEventCount).toBe(
      replacementInput.previousEvents.length,
    );
  });

  test("the superseded settlement writes the Package's durable note", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    await first;
    probe.handle("run-2").finish();
    await second;

    expect(probe.supersededRecordRuns).toEqual(["run-1"]);
    expect(storage.values.get("superseded-note:run-1")).toEqual({
      runId: "run-1",
    });
  });
});

describe("a Turn that has not dispatched a model request is left alone", () => {
  test("the new message queues and runs after it", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage, { dispatch: () => false });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;

    const second = probe.authority.run(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    await admitted();
    // No interrupt was signalled: there is no durable checkpoint to lose.
    expect(probe.interrupts).toEqual([]);
    expect(storage.values.get("pending-run")).toBe("run-2");
    expect(storedRun(storage, "run-1").supersededAt).toBeUndefined();

    probe.handle("run-1").finish();
    expect(await first).toMatchObject({ text: "done: first" });
    probe.handle("run-2").finish();
    expect(await second).toMatchObject({ text: "done: second" });

    expect(storedRun(storage, "run-1").status).toBe("completed");
    expect(storedRun(storage, "run-2").status).toBe("completed");
  });
});

describe("several messages in quick succession", () => {
  test("each earlier Turn is terminal, the last one runs, order is kept", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "one"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "two", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    // Sent before the object has finished admitting the one before it. The
    // admissions still serialize, so the last message wins.
    const third = probe.authority.run(
      command("run-3", "three", {
        lane: "user",
        supersedes: { runId: "run-2" },
      }),
    );
    await admitted();
    await first;
    await second;
    probe.handle("run-3").finish();
    await third;

    expect(storedRun(storage, "run-1").status).toBe("superseded");
    // The one that never started is terminal too, and appended no event.
    const skipped = storedRun(storage, "run-2");
    expect(skipped.status).toBe("superseded");
    expect(skipped.supersededBy).toBe("run-3");
    expect(skipped.events).toEqual([]);
    expect(storedRun(storage, "run-3").status).toBe("completed");
    // Only the two Turns that ran ever reached the Package, in order.
    expect(probe.observed.map((input) => input.command.text)).toEqual([
      "one",
      "three",
    ]);
  });
});

describe("supersede intent that names no run", () => {
  test("still replaces whatever is active", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;

    // The composer sent before it had observed its own run — a person typing
    // faster than the client polls. The intent is there; the provenance is
    // not, and the Bot supersedes whatever is actually active regardless.
    const second = probe.authority.run(
      command("run-2", "second", { lane: "user", supersedes: {} }),
    );
    await first;
    probe.handle("run-2").finish();
    await second;

    expect(storedRun(storage, "run-1").status).toBe("superseded");
    expect(storedRun(storage, "run-1").supersededBy).toBe("run-2");
    expect(storedRun(storage, "run-2").status).toBe("completed");
  });

  test("a replayed command replays and never interrupts a second Turn", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const superseding = command("run-2", "second", {
      lane: "user",
      supersedes: {},
    });

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(superseding);
    await first;
    probe.handle("run-2").finish();
    await second;

    // The same command again — a retried POST. The intent is in its
    // fingerprint, so this is the same command, and a replay reads back the
    // Turn it already produced rather than interrupting the one now running.
    const third = probe.authority.run(command("run-3", "third"));
    await probe.handle("run-3").started;
    const replay = await probe.authority.run(superseding);
    expect(replay.runId).toBe("run-2");
    expect(storedRun(storage, "run-3").supersededAt).toBeUndefined();

    probe.handle("run-3").finish();
    await third;
    expect(storedRun(storage, "run-3").status).toBe("completed");
  });
});

describe("a background admission never supersedes", () => {
  test("it is refused exactly as a second command always was", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);

    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;

    await expect(
      probe.authority.run(
        command("run-2", "firing", {
          turnType: "automation",
          supersedes: { runId: "run-1" },
        }),
      ),
    ).rejects.toThrow(/bot already has an active run/);
    // And a user-lane command with no supersede intent is refused too: an
    // interrupt is explicit or it does not happen.
    await expect(
      probe.authority.run(command("run-3", "second")),
    ).rejects.toThrow(/bot already has an active run/);

    probe.handle("run-1").finish();
    await first;
    expect(probe.interrupts).toEqual([]);
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

describe("eviction between the two Turns", () => {
  /**
   * Exactly what the object holds at the moment between the superseded Turn
   * terminalizing and the queued one starting: no active run, a queued run
   * record, and the pending marker naming it. Nothing else survives an
   * eviction, so nothing else is given to the object that comes back.
   */
  async function evictedAfterSupersede(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const first = probe.authority.run(command("run-1", "first"));
    await probe.handle("run-1").started;
    const second = probe.authority.run(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    await first.catch(() => undefined);
    // The caller that was waiting for the queued Turn is gone with the object.
    second.catch(() => undefined);
    const evicted = new MemoryStorage();
    for (const [key, value] of storage.values) {
      evicted.values.set(key, structuredClone(value));
    }
    return evicted;
  }

  test("a reconstructed object starts the queued Turn exactly once", async () => {
    const storage = await evictedAfterSupersede();
    expect(storage.values.get("pending-run")).toBe("run-2");
    expect(storage.values.get("active-run")).toBeUndefined();
    expect(storedRun(storage, "run-1").status).toBe("superseded");
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
