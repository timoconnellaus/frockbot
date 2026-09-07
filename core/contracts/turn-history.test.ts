import { describe, expect, test } from "bun:test";
import { currentTurnV1, messageTurnsV1 } from "./turn-history.js";
import type { SessionEvent } from "./types.js";

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

describe("turn history", () => {
  test("names the Turn each derived message belongs to", () => {
    expect(messageTurnsV1(events)).toEqual([1, 1, 2]);
    expect(currentTurnV1(events)).toBe(2);
    expect(currentTurnV1([])).toBe(0);
  });
});
