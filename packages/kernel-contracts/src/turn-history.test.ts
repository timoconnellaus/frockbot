import { describe, expect, test } from "bun:test";
import {
  currentTurnV1,
  freshTurnMessagesV1,
  messageTurnsV1,
  ownTurnMessagesV1,
} from "./turn-history.js";
import type { LlmMessage, SessionEvent } from "./types.js";

const events: SessionEvent[] = [
  {
    type: "turn/start",
    turn: 1,
    seq: 0,
    timestamp: "2026-09-01T00:00:00.000Z",
  },
  {
    type: "user/message",
    turn: 1,
    step: 0,
    messageId: "m-1",
    text: "first",
    seq: 1,
    timestamp: "2026-09-01T00:00:01.000Z",
  },
  {
    type: "assistant/message",
    turn: 1,
    step: 1,
    text: "answer",
    toolCalls: [],
    requestId: "r-1",
    seq: 2,
    timestamp: "2026-09-01T00:00:02.000Z",
  },
  {
    type: "turn/start",
    turn: 2,
    seq: 3,
    timestamp: "2026-09-01T00:00:03.000Z",
  },
  {
    type: "user/message",
    turn: 2,
    step: 0,
    messageId: "m-2",
    text: "second",
    seq: 4,
    timestamp: "2026-09-01T00:00:04.000Z",
  },
];

const messages: LlmMessage[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer", toolCalls: [] },
  { role: "user", content: "second" },
];

describe("turn history", () => {
  test("names the Turn each derived message belongs to", () => {
    expect(messageTurnsV1(events)).toEqual([1, 1, 2]);
    expect(currentTurnV1(events)).toBe(2);
    expect(currentTurnV1([])).toBe(0);
  });

  test("the open Turn's own messages are the ones it produced", () => {
    expect(ownTurnMessagesV1(events, messages)).toEqual([
      { role: "user", content: "second" },
    ]);
  });

  test("a request paired with the wrong session is a failure, not a guess", () => {
    expect(() => ownTurnMessagesV1(events, messages.slice(1))).toThrow(
      /disagree about their length/,
    );
  });

  test("fresh history replaces the transcript and keeps the Turn's own words", () => {
    const history: LlmMessage[] = [
      { role: "user", content: "beta: morning" },
      { role: "assistant", content: "on my way", toolCalls: [] },
    ];
    const fresh = freshTurnMessagesV1({ events, messages, history });
    expect(fresh).toEqual([...history, { role: "user", content: "second" }]);
    // Nothing from Turn 1 is in it: a `channel` Turn replays no personal
    // transcript, at any length.
    expect(fresh.some((message) => message.content === "first")).toBe(false);
    // And the caller's array is not shared with the request.
    expect(fresh[0]).not.toBe(history[0]);
  });
});
