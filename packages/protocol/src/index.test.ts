import { describe, expect, test } from "bun:test";
import { isAgentCommand, isAgentEvent, isPromptRequest } from "./index";

describe("protocol guards", () => {
  test("accepts a non-empty prompt", () => {
    expect(isPromptRequest({ runId: "run-1", text: "Hello" })).toBe(true);
    expect(
      isAgentCommand({ type: "prompt", runId: "run-1", text: "Hello" }),
    ).toBe(true);
  });

  test("rejects empty or malformed prompts", () => {
    expect(isPromptRequest({ runId: "run-1", text: "  " })).toBe(false);
    expect(isAgentCommand({ type: "prompt", runId: "", text: "Hello" })).toBe(
      false,
    );
  });

  test("checks streamed event fields", () => {
    expect(
      isAgentEvent({ type: "text-delta", runId: "run-1", text: "Hi" }),
    ).toBe(true);
    expect(isAgentEvent({ type: "text-delta", runId: "run-1" })).toBe(false);
  });
});
