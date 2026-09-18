// What a delivery Turn runs on, and what it does when there is nothing.
//
// The alarm decides to open a delivery Turn by reading the pending queue, and
// the person's own Turn can drain that queue before this one reaches it. The
// Turn is then holding a cue that says "nobody spoke" over an empty hand-off,
// on a chat Turn that holds `send_to_user` — the Bot speaking from nothing.
import { describe, expect, test } from "bun:test";
import { RoutineInboxStore } from "../routines/inbox-store.js";
import { createMemoryRoutineStorageV1 } from "../routines/testing.js";
import type { RoutinePendingWakeV1 } from "../routines/inbox.js";
import type { ShellBotStateV1 } from "./backend-state.js";
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
