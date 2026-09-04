// The exact sequence that wedged a Bot forever.
//
// A Turn interrupted mid-answer unwinds without writing a `turn/end`: its model
// request has no durable outcome and a `turn/end` would claim to know how it
// ended. Right while the run might resume; wrong once it will not. The
// settlement committed those events as they stood, so the durable session log
// ended inside an open turn, and every later message on that Bot failed
// validation with `turn 2 started while turn 1 is open` — printed verbatim into
// the person's next bubble, forever.
import { describe, expect, test } from "bun:test";
import {
  Session,
  type SessionEvent,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { SessionEventLog } from "./session-event-log.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";
import {
  cancelStoredRun,
  failStoredRun,
  supersedeStoredRun,
} from "./run-terminal.ts";

const codec = createStoredRunCodecV1<null>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: () => null,
});

const SESSION_ID = "user-1:primary";

const KEYS = {
  run: "run:run-1",
  activeRun: "active-run",
  latestEvents: "latest-events",
  notificationPrefix: "notification:",
};

/**
 * A Turn stopped after its model request went uncertain: `turn/start`,
 * `step/start`, a `user/message`, a `model/request`, and a
 * `model/reconciliation-required` — and then nothing. This is what the Agent
 * loop leaves behind when it unwinds on an abort.
 */
function interruptedJournal(): SessionEvent[] {
  const events: SessionEvent[] = [];
  const session = new Session(SESSION_ID, (envelope) => {
    events.push(envelope.event);
  });
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "message-1",
      text: "hello",
    },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "request-1",
        provider: "flock-ai",
        model: "@frock/auto",
        system: "",
        messages: [],
        tools: [],
      },
    },
    {
      type: "model/reconciliation-required",
      turn: 1,
      step: 1,
      requestId: "request-1",
      reason: "Model response outcome is uncertain after cancellation",
    },
  ]);
  return events;
}

function storedRun(
  events: SessionEvent[],
  intent: Partial<StoredRunV1<null>>,
): StoredRunV1<null> {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint-1",
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-03T00:00:00.000Z",
    input: "hello",
    events,
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: null,
    previousEventCount: 0,
    ...intent,
  };
}

async function settled(
  intent: Partial<StoredRunV1<null>>,
  settle: (storage: MemoryStorage, events: SessionEvent[]) => Promise<unknown>,
): Promise<{ storage: MemoryStorage; latest: SessionEvent[] }> {
  const storage = new MemoryStorage();
  const events = interruptedJournal();
  await storage.put({
    [KEYS.activeRun]: "run-1",
    [KEYS.run]: storedRun(events, intent),
    [KEYS.latestEvents]: events,
  });

  await settle(storage, events);

  return {
    storage,
    latest: await new SessionEventLog(storage).read(SESSION_ID),
  };
}

/** What the next Turn does: start turn 2 on the log the settlement left. */
function admitNextTurn(latest: SessionEvent[]): void {
  const session = new Session(SESSION_ID, () => {}, latest);
  session.append({ type: "turn/start", turn: 2 });
  validateToolOccurrenceJournal(session.events);
}

describe("settling a Turn interrupted mid-answer", () => {
  test("a superseded run leaves a log the next Turn can start on", async () => {
    const { latest, storage } = await settled(
      { supersededAt: "2026-09-03T00:01:00.000Z", supersededBy: "run-2" },
      (store, events) =>
        supersedeStoredRun(codec, store, KEYS, "run-1", [], events),
    );

    // Before the fix this threw "turn 2 started while turn 1 is open", and
    // every later message on this Bot answered 500 with that sentence.
    expect(() => admitNextTurn(latest)).not.toThrow();
    expect(latest.at(-1)).toMatchObject({ type: "turn/end", turn: 1 });
    // The settled record carries the same closed account, not a different one.
    const record = storage.values.get(KEYS.run) as Omit<
      StoredRunV1<null>,
      "events"
    >;
    expect(record.status).toBe("superseded");
    expect(Object.hasOwn(record, "events")).toBe(false);
    expect(record.eventRange).toEqual({ startSeq: 0, endSeq: latest.length });
  });

  test("a stopped run leaves a log the next Turn can start on", async () => {
    const { latest } = await settled(
      { stopRequestedAt: "2026-09-03T00:01:00.000Z" },
      (store, events) =>
        cancelStoredRun(codec, store, KEYS, "run-1", [], events),
    );

    expect(() => admitNextTurn(latest)).not.toThrow();
    expect(latest.at(-1)).toMatchObject({ type: "turn/end", turn: 1 });
  });

  test("a failed run leaves a log the next Turn can start on", async () => {
    const { latest } = await settled({}, (store, events) =>
      failStoredRun(
        codec,
        store,
        KEYS,
        "run-1",
        [],
        events,
        "the service restarted",
      ),
    );

    expect(() => admitNextTurn(latest)).not.toThrow();
    expect(latest.at(-1)).toMatchObject({ type: "turn/end", turn: 1 });
  });

  test("a Turn that closed itself is not closed twice", async () => {
    const storage = new MemoryStorage();
    const events: SessionEvent[] = [];
    const session = new Session(SESSION_ID, (envelope) => {
      events.push(envelope.event);
    });
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      { type: "step/end", turn: 1, step: 1, outcome: "cancelled" },
      { type: "turn/end", turn: 1, outcome: "cancelled" },
    ]);
    await storage.put({
      [KEYS.activeRun]: "run-1",
      [KEYS.run]: storedRun(events, {
        stopRequestedAt: "2026-09-03T00:01:00.000Z",
      }),
      [KEYS.latestEvents]: events,
    });

    await cancelStoredRun(codec, storage, KEYS, "run-1", [], events);

    const latest = await new SessionEventLog(storage).read(SESSION_ID);
    expect(latest.filter((event) => event.type === "turn/end")).toHaveLength(1);
    expect(() => admitNextTurn(latest)).not.toThrow();
  });
});
