import { describe, expect, test } from "bun:test";
import {
  decodeExternalAuthorizationUrl,
  isAgentCommand,
  isAgentEvent,
  isPromptRequest,
} from "./index";

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

  test("admits only bounded HTTPS authorization URLs", () => {
    expect(
      decodeExternalAuthorizationUrl("https://connect.example/authorize"),
    ).toBe("https://connect.example/authorize");
    for (const value of [
      "http://connect.example/authorize",
      "https://user:secret@connect.example/authorize",
      "https://connect.example/authorize#token",
      `https://connect.example/${"a".repeat(4_096)}`,
    ]) {
      expect(() => decodeExternalAuthorizationUrl(value)).toThrow(
        "invalid external authorization URL",
      );
    }
  });
});
