import { describe, expect, test } from "bun:test";
import { chatReducer, initialChatState } from "./chat-state";

describe("chatReducer", () => {
  test("creates a user and streaming assistant message", () => {
    const state = chatReducer(initialChatState, {
      type: "submit",
      runId: "run-1",
      text: "Hello",
    });
    expect(state.activeRunId).toBe("run-1");
    expect(state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("appends deltas to the matching assistant turn", () => {
    const submitted = chatReducer(initialChatState, {
      type: "submit",
      runId: "run-1",
      text: "Hello",
    });
    const streamed = chatReducer(submitted, {
      type: "agent-event",
      event: { type: "text-delta", runId: "run-1", text: "Hi there" },
    });
    expect(streamed.messages[1]?.text).toBe("Hi there");
  });

  test("settles an aborted run", () => {
    const submitted = chatReducer(initialChatState, {
      type: "submit",
      runId: "run-1",
      text: "Hello",
    });
    const settled = chatReducer(submitted, {
      type: "agent-event",
      event: { type: "settled", runId: "run-1", reason: "aborted" },
    });
    expect(settled.activeRunId).toBeUndefined();
    expect(settled.messages[1]).toMatchObject({
      status: "aborted",
      text: "Stopped.",
    });
  });

  test("marks a worker exit as recoverable disconnection", () => {
    const disconnected = chatReducer(initialChatState, {
      type: "agent-event",
      event: { type: "worker-exit", code: 1 },
    });
    expect(disconnected.connection).toBe("disconnected");
    expect(disconnected.error).toContain("code 1");
  });
});
