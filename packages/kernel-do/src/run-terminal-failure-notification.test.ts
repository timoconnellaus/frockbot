// A Turn that ends `failed` owes the person who was waiting on it the same
// kind of notice a completed one gives them. Before this, only a completed
// Turn recorded a notification intent, so a deadline, a provider outage or a
// restart reached nobody who was not still looking at that conversation.
import { describe, expect, test } from "bun:test";
import { Session, type SessionEvent } from "@frockbot/kernel-contracts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1, type StoredRunV1 } from "./run-records.ts";
import { failStoredRun } from "./run-terminal.ts";

interface Snapshot {
  name: string;
  notify: boolean;
}

const codec = createStoredRunCodecV1<Snapshot>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: (value) => value as Snapshot,
});

const SESSION_ID = "user-1:primary";

const KEYS = {
  run: "run:run-1",
  activeRun: "active-run",
  latestEvents: "latest-events",
  notificationPrefix: "notification:",
};

/** The Package policy under test: it reads the run's own durable snapshot. */
function failureNotification(run: StoredRunV1<Snapshot>) {
  if (!run.configurationSnapshot.notify) return undefined;
  return {
    notificationId: `run-failed-${run.runId}`,
    runId: run.runId,
    createdAt: "2026-09-05T00:00:00.000Z",
    title: `${run.configurationSnapshot.name} couldn't finish`,
    body: "This Bot couldn't finish its reply. Try again.",
  };
}

function journal(): SessionEvent[] {
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
  ]);
  return events;
}

function storedRun(
  events: SessionEvent[],
  intent: Partial<StoredRunV1<Snapshot>>,
): StoredRunV1<Snapshot> {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint-1",
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-05T00:00:00.000Z",
    input: "hello",
    events,
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: { name: "Bob", notify: true },
    previousEventCount: 0,
    ...intent,
  };
}

async function settledStorage(
  intent: Partial<StoredRunV1<Snapshot>> = {},
): Promise<{ storage: MemoryStorage; events: SessionEvent[] }> {
  const storage = new MemoryStorage();
  const events = journal();
  await storage.put({
    [KEYS.activeRun]: "run-1",
    [KEYS.run]: storedRun(events, intent),
    [KEYS.latestEvents]: events,
  });
  return { storage, events };
}

function notifications(storage: MemoryStorage): unknown[] {
  return [...storage.values.entries()]
    .filter(([key]) => key.startsWith(KEYS.notificationPrefix))
    .map(([, value]) => value);
}

describe("the notification a failed Turn records", () => {
  test("is composed from the snapshot the Turn was admitted under", async () => {
    const { storage, events } = await settledStorage();

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "Bot turn ended with outcome model-error: Model request failed (401)",
      undefined,
      failureNotification,
    );

    expect(notifications(storage)).toEqual([
      {
        notificationId: "run-failed-run-1",
        runId: "run-1",
        createdAt: "2026-09-05T00:00:00.000Z",
        title: "Bob couldn't finish",
        body: "This Bot couldn't finish its reply. Try again.",
      },
    ]);
  });

  test("is not recorded when the Bot's own policy declines it", async () => {
    const { storage, events } = await settledStorage({
      configurationSnapshot: { name: "Bob", notify: false },
    });

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "Bot turn ended with outcome model-error",
      undefined,
      failureNotification,
    );

    expect(notifications(storage)).toEqual([]);
  });

  test("is written once, however often the run is settled again", async () => {
    const { storage, events } = await settledStorage();

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "the service restarted",
      undefined,
      failureNotification,
    );
    // What acknowledging it does. A recovery pass over the same run must not
    // bring it back — the person has already read it.
    storage.values.delete(`${KEYS.notificationPrefix}run-failed-run-1`);

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "the service restarted",
      undefined,
      failureNotification,
    );

    expect(notifications(storage)).toEqual([]);
  });

  test("is not recorded for a Turn a later message replaced", async () => {
    const { storage, events } = await settledStorage({
      supersededAt: "2026-09-05T00:01:00.000Z",
      supersededBy: "run-2",
    });

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "Bot turn ended with outcome model-error",
      undefined,
      failureNotification,
    );

    expect((storage.values.get(KEYS.run) as StoredRunV1<Snapshot>).status).toBe(
      "superseded",
    );
    expect(notifications(storage)).toEqual([]);
  });

  test("is not recorded for a Turn the person stopped", async () => {
    const { storage, events } = await settledStorage({
      stopRequestedAt: "2026-09-05T00:01:00.000Z",
    });

    await failStoredRun(
      codec,
      storage,
      KEYS,
      "run-1",
      [],
      events,
      "Bot turn ended with outcome model-error",
      undefined,
      failureNotification,
    );

    expect((storage.values.get(KEYS.run) as StoredRunV1<Snapshot>).status).toBe(
      "cancelled",
    );
    expect(notifications(storage)).toEqual([]);
  });
});
