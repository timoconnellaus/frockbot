// A record that says `running` over a Turn that is over.
//
// Nothing but a settlement moves a record off `running`, so a Turn that died
// mid-answer — a Worker torn down, one of the "turn N started while turn N-1
// is open" wedges — would say `running` for ever. Liveness is three
// conditions, not one, and a record failing them is settled durably: by
// recovery when it is the active Turn, by the alarm's repair index otherwise.
// Reads report the record as it stands, so every surface changes together.
import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "./composition/generation.js";
import {
  type SessionEvent,
  TURN_DEADLINE_MS_V1,
} from "@frockbot/core/contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";
import {
  runLivenessV1,
  STALE_RUNNING_RUN_FAILURE_V1,
  STALE_RUNNING_RUN_GRACE_MS_V1,
} from "./run-liveness.ts";
import { SessionEventLog } from "./session-event-log.ts";
import {
  ACTIVE_RUN_KEY,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  RUN_PREFIX,
  repairDueKey,
  repairRunKey,
  runIndexKey,
} from "./storage-keys.ts";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const ACCEPTED_AT = new Date(NOW - 1000).toISOString();

function event(
  seq: number,
  type: SessionEvent["type"],
  extra: Record<string, unknown> = {},
): SessionEvent {
  return {
    type,
    seq,
    timestamp: new Date(NOW - 1000 + seq).toISOString(),
    ...extra,
  } as SessionEvent;
}

/** The events one Turn writes while it runs, opening the Turn and no more. */
const openTurn: SessionEvent[] = [
  event(0, "turn/start", { turn: 1 }),
  event(1, "step/start", { turn: 1, step: 1 }),
];

/** The same log, with the ending somebody else wrote for it. */
const closedTurn: SessionEvent[] = [
  ...openTurn,
  event(2, "step/end", { turn: 1, step: 1, outcome: "interrupted" }),
  event(3, "turn/end", { turn: 1, outcome: "interrupted" }),
];

function run(
  overrides: Partial<StoredRunV1<undefined>> = {},
): StoredRunV1<undefined> {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint",
    sessionId: "user-1:primary",
    acceptedAt: ACCEPTED_AT,
    input: "hello",
    events: openTurn,
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: undefined,
    previousEventCount: 0,
    ...overrides,
  };
}

describe("whether a run marked running is working", () => {
  test("a Turn admitted a moment ago is working", () => {
    expect(
      runLivenessV1({ run: run(), sessionEvents: openTurn, now: NOW }),
    ).toEqual({ working: true, stale: false });
  });

  test("a settled run is not working, and owes no repair", () => {
    expect(
      runLivenessV1({
        run: run({ status: "completed" }),
        sessionEvents: closedTurn,
        now: NOW,
      }),
    ).toEqual({ working: false, stale: false });
  });

  test("one still inside the deadline is left alone", () => {
    expect(
      runLivenessV1({
        run: run(),
        sessionEvents: openTurn,
        now: NOW + TURN_DEADLINE_MS_V1 - 1000,
      }),
    ).toEqual({ working: true, stale: false });
  });

  test("the grace covers the unwind after the deadline fires", () => {
    expect(
      runLivenessV1({
        run: run(),
        sessionEvents: openTurn,
        now: NOW + TURN_DEADLINE_MS_V1 + STALE_RUNNING_RUN_GRACE_MS_V1 - 1000,
      }).working,
    ).toBe(true);
  });

  test("one past the deadline and its grace is stale", () => {
    expect(
      runLivenessV1({
        run: run(),
        sessionEvents: openTurn,
        now: NOW + TURN_DEADLINE_MS_V1 + STALE_RUNNING_RUN_GRACE_MS_V1 + 1000,
      }),
    ).toEqual({ working: false, stale: true, reason: "deadline" });
  });

  test("one whose Turn the log already closed is stale, however fresh", () => {
    expect(
      runLivenessV1({ run: run(), sessionEvents: closedTurn, now: NOW }),
    ).toEqual({ working: false, stale: true, reason: "turn-closed" });
  });

  test("an earlier Turn's ending says nothing about this one", () => {
    // The log ends closed because the *previous* Turn closed it, and this run
    // has not journaled its own `turn/start` yet.
    expect(
      runLivenessV1({
        run: run({ events: [], previousEventCount: closedTurn.length }),
        sessionEvents: closedTurn,
        now: NOW,
      }),
    ).toEqual({ working: true, stale: false });
  });

  test("an unreadable admission time is not evidence of death", () => {
    expect(
      runLivenessV1({
        run: run({ acceptedAt: "not a timestamp" }),
        sessionEvents: openTurn,
        now: NOW + TURN_DEADLINE_MS_V1 * 100,
      }).stale,
    ).toBe(false);
  });
});

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt: "2026-09-03T00:00:00.000Z" });
}

const hooks: BotDurableAuthorityHooks<undefined> = {
  resolveAdmissionSnapshot: () => Promise.resolve(undefined),
  bootstrapComposition: () => bootstrap(),
  admittedSnapshot: () => Promise.resolve(undefined),
  executeTurn: () => Promise.reject(new Error("no Turn should execute here")),
  notification: () => undefined,
  scheduledDeadlines: () => Promise.resolve([]),
  scheduledWorkInFlight: () => false,
  deferScheduledWork: () => Promise.resolve(),
  settleScheduledWork: () => Promise.resolve(),
};

/**
 * A Bot left holding exactly what production was left holding: a record that
 * says `running`, an `active-run` marker pointing at it, and a durable log with
 * the Turn it opened.
 */
async function seed(input: {
  acceptedAt: string;
  events: SessionEvent[];
  log: SessionEvent[];
}): Promise<{
  storage: MemoryStorage;
  authority: BotDurableAuthority<undefined>;
}> {
  const storage = new MemoryStorage();
  const stored = run({ acceptedAt: input.acceptedAt, events: input.events });
  await storage.put({
    [`${RUN_PREFIX}${stored.runId}`]: stored,
    [runIndexKey(stored.acceptedAt, stored.runId)]: stored.runId,
    [ACTIVE_RUN_KEY]: stored.runId,
    [LATEST_EVENTS_KEY]: input.log,
    [IDENTITY_KEY]: { userId: "user-1", botId: "primary" },
  });
  const authority = new BotDurableAuthority<undefined>({
    state: { storage } as unknown as DurableObjectState,
    codec,
    hooks,
  });
  return { storage, authority };
}

const longAgo = new Date(
  Date.now() - TURN_DEADLINE_MS_V1 - STALE_RUNNING_RUN_GRACE_MS_V1 - 60_000,
).toISOString();

describe("a stale record is settled by the alarm or recovery, never by a read", () => {
  test("the alarm settles a deadline miss", async () => {
    const { storage, authority } = await seed({
      acceptedAt: longAgo,
      events: openTurn,
      log: openTurn,
    });
    const due = Date.now() - 1_000;
    await storage.put({
      [repairRunKey("run-1")]: due,
      [repairDueKey(due, "run-1")]: "run-1",
    });
    await storage.delete(ACTIVE_RUN_KEY);
    await authority.alarm();
    const settled = await storage.get<StoredRunV1<undefined>>(
      `${RUN_PREFIX}run-1`,
    );
    expect(settled?.status).toBe("failed");
    expect(settled?.failure).toBe(STALE_RUNNING_RUN_FAILURE_V1);
    expect(await storage.get<string>(ACTIVE_RUN_KEY)).toBeUndefined();
    const log = await new SessionEventLog(storage).read("user-1:primary");
    expect(log.some((entry) => entry.type === "turn/end")).toBe(true);
  });

  test("recovery settles a closed Turn", async () => {
    const { storage, authority } = await seed({
      acceptedAt: new Date().toISOString(),
      events: openTurn,
      log: closedTurn,
    });
    await authority.recoverActiveRun();
    expect(
      (await storage.get<StoredRunV1<undefined>>(`${RUN_PREFIX}run-1`))?.status,
    ).toBe("failed");
  });

  test("a second alarm does not rewrite what the first settled", async () => {
    const { storage, authority } = await seed({
      acceptedAt: longAgo,
      events: openTurn,
      log: openTurn,
    });
    const due = Date.now() - 1_000;
    await storage.put({
      [repairRunKey("run-1")]: due,
      [repairDueKey(due, "run-1")]: "run-1",
    });
    await storage.delete(ACTIVE_RUN_KEY);
    await authority.alarm();
    const first = await storage.get<StoredRunV1<undefined>>(
      `${RUN_PREFIX}run-1`,
    );
    await authority.alarm();
    expect(
      await storage.get<StoredRunV1<undefined>>(`${RUN_PREFIX}run-1`),
    ).toEqual(first!);
  });
});
