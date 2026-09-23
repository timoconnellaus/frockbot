import { describe, expect, test } from "bun:test";
import { voiceOpeningRereadsSessionMemoryV1 } from "./session-memory.js";

describe("voice session memory", () => {
  test("the initial opening reuses the prompt's read", () => {
    expect(voiceOpeningRereadsSessionMemoryV1({})).toBe(false);
  });

  test("a wake or handover reads again", () => {
    expect(voiceOpeningRereadsSessionMemoryV1({ resume: true })).toBe(true);
    expect(voiceOpeningRereadsSessionMemoryV1({ handover: true })).toBe(true);
  });
});
