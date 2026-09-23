// What a delivery Turn runs on, and what it does when there is nothing.
//
// The alarm decides to open a delivery Turn by reading the pending queue, and
// the person's own Turn can drain that queue before this one reaches it. The
// Turn is then holding a cue that says "nobody spoke" over an empty hand-off,
// on a chat Turn that holds `send_to_user` — the Bot speaking from nothing.
import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import { Session, type SessionEvent } from "@frockbot/core/contracts";
import {
  requeueDrainedInputsV1,
  RoutineInboxStore,
} from "../routines/inbox-store.js";
import {
  createMemoryRoutineStorageV1,
  type MemoryRoutineStorageV1,
} from "../routines/testing.js";
import type { RoutinePendingWakeV1 } from "../routines/inbox.js";
import { failedTurnRecordsV1 } from "../notifications/bot.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import { shellTerminalRecordsV1 } from "./terminal-records.js";
import { turnInputTextV1 } from "./turn.js";

function stateWith(inbox: RoutineInboxStore): ShellBotStateV1 {
  // SAFETY: the input text a Turn runs on is drawn from the pending-input
  // queue and nothing else on the state.
  return { routineInbox: inbox } as unknown as ShellBotStateV1;
}

function wake(runId: string, text: string): RoutinePendingWakeV1 {
  return {
    schemaVersion: 1,
    kind: "wake",
    wakeId: `rw-${runId}`,
    runId,
    routineId: "morning-brief",
    title: "Automation: Morning brief",
    text,
    createdAt: "2026-09-16T23:45:00.000Z",
    quiet: { automation: true },
  };
}

const CUE = "[Delivery] Nobody has said anything to you.";

describe("the text a delivery Turn runs on", () => {
  test("carries the drained hand-off ahead of the cue", async () => {
    const inbox = new RoutineInboxStore(createMemoryRoutineStorageV1());
    await inbox.enqueue(wake("rf-1", "Two overnight emails need you."));

    const text = await turnInputTextV1(stateWith(inbox), {
      runId: "rd-rf-1",
      text: CUE,
      turnType: "chat",
      origin: { kind: "routine-delivery", wakeRunId: "rf-1" },
    });

    expect(text).toContain("Two overnight emails need you.");
    expect(text).toContain(CUE);
  });

  test("ends the Turn when the queue was drained out from under it", async () => {
    const inbox = new RoutineInboxStore(createMemoryRoutineStorageV1());
    await inbox.enqueue(wake("rf-1", "Two overnight emails need you."));
    // The person's own Turn, admitted and drained inside the window between
    // the alarm reading the queue and this Turn reaching it.
    expect(await inbox.drainInto("chat-1")).toHaveLength(1);

    const text = await turnInputTextV1(stateWith(inbox), {
      runId: "rd-rf-1",
      text: CUE,
      turnType: "chat",
      origin: { kind: "routine-delivery", wakeRunId: "rf-1" },
    });

    // No text at all: the Turn exists only to carry the hand-off, so with
    // nothing to carry it ends without a model call rather than answering a
    // cue that says nobody spoke.
    expect(text).toBeUndefined();
  });

  test("an ordinary chat Turn with an empty queue still runs on the person's words", async () => {
    const inbox = new RoutineInboxStore(createMemoryRoutineStorageV1());

    expect(
      await turnInputTextV1(stateWith(inbox), {
        runId: "chat-1",
        text: "what happened overnight?",
        turnType: "chat",
      }),
    ).toBe("what happened overnight?");
  });
});

// A delivery Turn is opened by the alarm with nobody present, and it drains
// the queue before the model runs. Every way it can end other than completing
// therefore used to swallow the hand-off: the person's next Turn carried
// nothing, and for a failure the thread showed a bare failure notice with no
// bubble above it. What these prove is the one guarantee that makes the
// proactive Turn safe to open at all — a hand-off survives a delivery Turn
// that did not deliver, and is still carried by the Bot's next conversational
// Turn exactly as it was before any delivery Turn existed.
const HANDOFF = "Two overnight emails need you.";

/** The drained delivery Turn, and the store it drained from. */
async function drainedDeliveryTurn(): Promise<{
  storage: MemoryRoutineStorageV1;
  inbox: RoutineInboxStore;
}> {
  const storage = createMemoryRoutineStorageV1();
  const inbox = new RoutineInboxStore(storage);
  await inbox.enqueue(wake("rf-1", HANDOFF));
  const text = await turnInputTextV1(stateWith(inbox), {
    runId: "rd-rf-1",
    text: CUE,
    turnType: "chat",
    origin: { kind: "routine-delivery", wakeRunId: "rf-1" },
  });
  expect(text).toContain(HANDOFF);
  expect(await inbox.pending()).toHaveLength(0);
  return { storage, inbox };
}

/** The kernel's own write-back of what a settlement returned. */
async function applyV1(
  storage: MemoryRoutineStorageV1,
  records: Record<string, unknown>,
): Promise<void> {
  for (const [key, value] of Object.entries(records)) {
    await storage.put(key, value);
  }
}

/** What the person's own next chat Turn is handed. */
function nextChatTurnText(
  inbox: RoutineInboxStore,
): Promise<string | undefined> {
  return turnInputTextV1(stateWith(inbox), {
    runId: "chat-2",
    text: "morning",
    turnType: "chat",
  });
}

/** A chat Turn that ran a tool step and yielded before it answered. */
function yieldedChatTurn(): SessionEvent[] {
  const session = new Session("user-1:primary");
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "turn/admission", turn: 1, turnType: "chat" } as SessionEvent,
    { type: "turn/end", turn: 1, outcome: "completed" },
  ]);
  return [...session.activeRunJournal];
}

function chatAdmission(): SessionEvent[] {
  const session = new Session("user-1:primary");
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "turn/admission", turn: 1, turnType: "chat" } as SessionEvent,
  ]);
  return [...session.activeRunJournal];
}

describe("a delivery Turn that did not deliver", () => {
  test("a failed delivery leaves the hand-off deliverable", async () => {
    const { storage, inbox } = await drainedDeliveryTurn();

    await applyV1(
      storage,
      await failedTurnRecordsV1({
        settings: {
          ...initializeBotSettingsV1("primary"),
          profile: { name: "Bob" },
          notifications: { enabled: true },
        },
        read: <T>(key: string) => storage.get<T>(key),
        failed: {
          runId: "rd-rf-1",
          failure: "Bot turn ended with outcome model-error: 401",
          events: chatAdmission(),
          admission: {
            schemaVersion: 1,
            turnType: "chat",
            origin: { kind: "routine-delivery", wakeRunId: "rf-1" },
          },
        },
      }),
    );

    expect(await inbox.pending()).toHaveLength(1);
    expect(await nextChatTurnText(inbox)).toContain(HANDOFF);
  });

  test("a delivery that yields keeps its hand-off in its own history", async () => {
    const { storage, inbox } = await drainedDeliveryTurn();

    // A delivery Turn ends at a step boundary when the person speaks. Unlike
    // a failure it completed: the hand-off is its own input, already in the
    // history the person's Turn reads, so only the note that it was
    // unfinished goes on the queue.
    await applyV1(
      storage,
      await shellTerminalRecordsV1({
        run: {
          runId: "rd-rf-1",
          sessionId: "user-1:primary",
          acceptedAt: "2026-09-16T23:45:00.000Z",
          input: CUE,
          events: yieldedChatTurn(),
          admission: {
            turnType: "chat",
            origin: { kind: "routine-delivery" },
          },
        },
        cursor: "run-index:2026-09-16T23:45:00.000Z:rd-rf-1",
        now: "2026-09-16T23:45:05.000Z",
        read: <T>(key: string) => storage.get<T>(key),
      }),
    );

    const queued = await inbox.pending();
    expect(queued.map(({ input }) => input.kind)).toEqual(["yielded-turn"]);
    expect(await nextChatTurnText(inbox)).not.toContain(HANDOFF);
  });

  test("a stopped delivery leaves the hand-off deliverable", async () => {
    const { storage, inbox } = await drainedDeliveryTurn();

    // What `stopRun` composes into the transaction that records Stop intent.
    await storage.transaction((transaction) =>
      requeueDrainedInputsV1(transaction, "rd-rf-1"),
    );

    expect(await inbox.pending()).toHaveLength(1);
    expect(await nextChatTurnText(inbox)).toContain(HANDOFF);
  });

  test("a failed chat Turn the person started re-queues nothing", async () => {
    const storage = createMemoryRoutineStorageV1();
    const inbox = new RoutineInboxStore(storage);
    await inbox.enqueue(wake("rf-1", HANDOFF));
    expect(
      await turnInputTextV1(stateWith(inbox), {
        runId: "chat-1",
        text: "morning",
        turnType: "chat",
      }),
    ).toContain(HANDOFF);

    await applyV1(
      storage,
      await failedTurnRecordsV1({
        settings: {
          ...initializeBotSettingsV1("primary"),
          profile: { name: "Bob" },
          notifications: { enabled: true },
        },
        read: <T>(key: string) => storage.get<T>(key),
        failed: {
          runId: "chat-1",
          failure: "Bot turn ended with outcome model-error: 401",
          events: chatAdmission(),
        },
      }),
    );

    // The person was there and can ask again. Giving it back would make the
    // Bot re-tell a triage it may already have relayed before it failed.
    expect(await inbox.pending()).toHaveLength(0);
    expect(await nextChatTurnText(inbox)).toBe("morning");
  });

  test("a completed delivery consumes the hand-off exactly once", async () => {
    const { inbox } = await drainedDeliveryTurn();

    // Nothing settles a completed Turn back onto the queue, and the receipt
    // the recovered Turn reads back is not a second delivery.
    expect(await nextChatTurnText(inbox)).toBe("morning");
  });
});
