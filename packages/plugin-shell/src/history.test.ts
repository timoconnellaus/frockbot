import { describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  type LlmMessage,
  type SessionEvent,
  type SessionEventInput,
} from "@frockbot/kernel-contracts";
import {
  automationParentPointerV1,
  currentTurnV1,
  turnScopedMessagesV1,
  turnTypesByTurnV1,
} from "./history.js";

function log(inputs: SessionEventInput[]): SessionEvent[] {
  return inputs.map((input, index) =>
    decodeSessionEvent({
      ...input,
      seq: index,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    }),
  );
}

/** The same derivation `Session.deriveMessages` performs, over a fixed log. */
function derive(events: readonly SessionEvent[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const event of events) {
    if (event.type === "user/message") {
      messages.push({ role: "user", content: event.text });
    } else if (event.type === "assistant/message") {
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: event.toolCalls,
      });
    }
  }
  return messages;
}

function turn(
  turnNumber: number,
  turnType: "chat" | "automation",
  text: string,
  reply: string,
): SessionEventInput[] {
  return [
    { type: "turn/start", turn: turnNumber },
    { type: "turn/admission", turn: turnNumber, turnType },
    { type: "step/start", turn: turnNumber, step: 1 },
    {
      type: "user/message",
      turn: turnNumber,
      step: 1,
      messageId: `m-${turnNumber}`,
      text,
    },
    {
      type: "assistant/message",
      turn: turnNumber,
      step: 1,
      requestId: `r-${turnNumber}`,
      text: reply,
      toolCalls: [],
    },
    { type: "step/end", turn: turnNumber, step: 1, outcome: "completed" },
    { type: "turn/end", turn: turnNumber, outcome: "completed" },
  ];
}

function scoped(events: SessionEvent[]): LlmMessage[] {
  return turnScopedMessagesV1({
    events,
    messages: derive(events),
    pointer: automationParentPointerV1,
    sessionId: "bot:scout",
  });
}

function scopedWithBudget(events: SessionEvent[], budget: number) {
  return turnScopedMessagesV1({
    events,
    messages: derive(events),
    pointer: automationParentPointerV1,
    sessionId: "bot:scout",
    budget,
  });
}

describe("one request carries a bounded amount of history", () => {
  test("keeps the current Turn whole and drops the oldest, with a notice", () => {
    const events = log([
      ...turn(1, "chat", "the oldest thing", "first reply"),
      ...turn(2, "chat", "the middle thing", "second reply"),
      ...turn(3, "chat", "the newest thing", ""),
    ]);
    // Room for the current Turn and one older one, not for all three.
    const messages = scopedWithBudget(events, 200);

    const contents = messages.map((message) => message.content);
    expect(contents).toContain("the newest thing");
    expect(contents.join(" ")).not.toContain("the oldest thing");
    expect(contents[0]).toContain("not included here");
    expect(contents[0]).toContain("1 Turn");
  });

  test("carries everything when it fits, and says nothing about omission", () => {
    const events = log([
      ...turn(1, "chat", "morning", "hello"),
      ...turn(2, "chat", "anything new?", ""),
    ]);

    expect(
      scopedWithBudget(events, 100_000).map((message) => message.content),
    ).toEqual(["morning", "hello", "anything new?", ""]);
  });

  test("keeps the current Turn even when it alone exceeds the budget", () => {
    const events = log([
      ...turn(1, "chat", "old", "older"),
      ...turn(2, "chat", "x".repeat(500), ""),
    ]);
    const messages = scopedWithBudget(events, 50);

    // A Turn is never split: dropping the user message and keeping the reply
    // would be a malformed request, so the current Turn survives whole.
    expect(messages.at(-2)!.content).toBe("x".repeat(500));
    expect(messages[0]!.content).toContain("not included here");
  });
});

describe("turn-scoped prompt history", () => {
  test("a chat Turn sees only the Turns admitted as chat", () => {
    const events = log([
      ...turn(1, "chat", "morning", "hello"),
      ...turn(2, "automation", "Routine fired", "checked the inbox"),
      ...turn(3, "chat", "anything new?", ""),
    ]);
    expect(scoped(events).map((message) => message.content)).toEqual([
      "morning",
      "hello",
      "anything new?",
      "",
    ]);
  });

  test("an automation Turn starts from a pointer and its own Turn only", () => {
    const events = log([
      ...turn(1, "chat", "morning", "hello"),
      ...turn(2, "chat", "and again", "hi"),
      { type: "turn/start", turn: 3 },
      { type: "turn/admission", turn: 3, turnType: "automation" },
      { type: "step/start", turn: 3, step: 1 },
      {
        type: "user/message",
        turn: 3,
        step: 1,
        messageId: "m-3",
        text: "Routine fired",
      },
    ]);
    const messages = scoped(events);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain('session "bot:scout"');
    expect(messages[0]!.content).toContain("2 conversational Turns");
    expect(messages[0]!.content).toContain("wake_parent");
    expect(messages[0]!.content).not.toContain("morning");
    expect(messages[1]!.content).toBe("Routine fired");
  });

  test("a Turn recorded before turn admission existed replays as chat", () => {
    const events = log([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "user/message",
        turn: 1,
        step: 1,
        messageId: "m-1",
        text: "legacy",
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
      { type: "turn/end", turn: 1, outcome: "completed" },
      ...turn(2, "chat", "now", "then"),
    ]);
    expect(scoped(events).map((message) => message.content)).toEqual([
      "legacy",
      "now",
      "then",
    ]);
  });

  test("the admission markers and the open turn are read off the log", () => {
    const events = log([
      ...turn(1, "chat", "one", "two"),
      { type: "turn/start", turn: 2 },
      { type: "turn/admission", turn: 2, turnType: "automation" },
    ]);
    expect(turnTypesByTurnV1(events).get(2)).toBe("automation");
    expect(currentTurnV1(events)).toBe(2);
  });

  test("a derivation that disagrees with the log is a visible failure", () => {
    const events = log(turn(1, "chat", "one", "two"));
    expect(() =>
      turnScopedMessagesV1({
        events,
        messages: [],
        pointer: automationParentPointerV1,
        sessionId: "bot:scout",
      }),
    ).toThrow("disagree about their length");
  });
});
