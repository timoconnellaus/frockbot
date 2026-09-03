/**
 * What a Turn the User's next message replaced looks like to the model request
 * that follows it.
 *
 * The whole answer is in the durable log: `deriveMessages` walks the events and
 * reads nothing else, so a superseded Turn contributes exactly what it made
 * durable — what it said, and what its tools actually returned. There is no
 * branch for supersede here, and that is the point: the next request is
 * reconstructed from events, so a Turn that ended early is a Turn with fewer
 * events, not a Turn with a special case.
 */
import { describe, expect, test } from "bun:test";
import { Session } from "./session.js";
import type { SessionEvent } from "./types.js";

const timestamp = "2026-09-03T00:00:00.000Z";

function session(): Session {
  return new Session("user-1:primary", () => {});
}

/**
 * A Turn that sent a line, completed one tool call, and had a second still in
 * flight when the User's next message arrived.
 */
function supersededTurn(target: Session): void {
  target.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    { type: "user/message", turn: 1, step: 1, messageId: "m-1", text: "go" },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "starting",
      toolCalls: [
        { id: "call-a", name: "read", input: {} },
        { id: "call-b", name: "write", input: {} },
      ],
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "read",
      input: {},
    },
    {
      type: "tool/result",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: "read",
      content: "the notes say hello",
      isError: false,
      status: "completed",
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:1",
      name: "write",
      input: {},
    },
  ]);
}

describe("the next Turn's request derives from what the superseded Turn recorded", () => {
  test("its sends and completed tool results are visible; the in-flight one is not claimed", () => {
    const target = session();
    supersededTurn(target);
    // The interrupt: every unresolved effect is closed as interrupted, and the
    // Turn is ended. This is the same repair a Stop makes.
    target.reconcileInterrupted();

    const messages = target.deriveMessages();

    expect(messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "starting",
        toolCalls: [
          { id: "call-a", name: "read", input: {} },
          { id: "call-b", name: "write", input: {} },
        ],
      },
      {
        role: "tool",
        callId: "call-a",
        name: "read",
        content: "the notes say hello",
        isError: false,
      },
      {
        role: "tool",
        callId: "call-b",
        name: "write",
        content: "Interrupted before a durable result was recorded.",
        isError: true,
      },
    ]);
    // The Turn ended, and the log says so. Nothing was invented for the effect
    // that never returned: it is present, and it is an error.
    expect(target.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "interrupted",
    });
  });

  test("the new Turn's own message is simply the next one in the log", () => {
    const target = session();
    supersededTurn(target);
    target.reconcileInterrupted();
    target.appendBatch([
      { type: "turn/start", turn: 2 },
      { type: "step/start", turn: 2, step: 1 },
      {
        type: "user/message",
        turn: 2,
        step: 1,
        messageId: "m-2",
        text: "actually, do this instead",
      },
    ]);

    const messages = target.deriveMessages();

    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "actually, do this instead",
    });
    // Deterministic: the same events derive the same request every time.
    expect(target.deriveMessages()).toEqual(messages);
    const replayed = new Session(
      "user-1:primary",
      () => {},
      target.events as readonly SessionEvent[],
    );
    expect(replayed.deriveMessages()).toEqual(messages);
  });
});
