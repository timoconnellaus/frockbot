import { describe, expect, test } from "bun:test";
import {
  answerEveryToolCallV1,
  currentTurnV1,
  messageTurnsV1,
  UNRUN_TOOL_CALL_RESULT_V1,
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

describe("turn history", () => {
  test("names the Turn each derived message belongs to", () => {
    expect(messageTurnsV1(events)).toEqual([1, 1, 2]);
    expect(currentTurnV1(events)).toBe(2);
    expect(currentTurnV1([])).toBe(0);
  });
});

describe("answering every tool call", () => {
  const interrupted: LlmMessage[] = [
    { role: "user", content: "change the theme" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-ran", name: "computer_exec", input: {} },
        { id: "call-never-ran", name: "computer_exec", input: {} },
      ],
    },
    {
      role: "tool",
      callId: "call-ran",
      name: "computer_exec",
      content: "Interrupted before a durable result was recorded.",
      isError: true,
    },
    { role: "user", content: "can you build a tuner" },
  ];

  test("answers a parallel call an interrupted Turn never started", () => {
    expect(answerEveryToolCallV1(interrupted)).toEqual([
      interrupted[0]!,
      interrupted[1]!,
      interrupted[2]!,
      {
        role: "tool",
        callId: "call-never-ran",
        name: "computer_exec",
        content: UNRUN_TOOL_CALL_RESULT_V1,
        isError: true,
      },
      interrupted[3]!,
    ]);
  });

  test("returns the same messages when every call is answered", () => {
    const complete = interrupted.filter(
      (message) => message.role !== "assistant",
    );
    expect(answerEveryToolCallV1(complete)).toBe(complete);
  });
});
