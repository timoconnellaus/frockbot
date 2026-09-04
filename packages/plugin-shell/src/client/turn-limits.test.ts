import { describe, expect, test } from "bun:test";
import {
  TURN_TEXT_COUNTER_FROM_V1,
  TURN_TEXT_MAX_CHARACTERS_V1,
  turnTextCounterVisibleV1,
  turnTextRemainingV1,
  turnTextTooLongV1,
} from "./turn-limits.js";

describe("the composer's copy of the send limit", () => {
  test("mirrors the number the send route refuses on", () => {
    // The gateway's `TURN_TEXT_MAX_CHARACTERS_V1`. Pinned here because the two
    // are only equal by intent: the client cannot import the Worker's module.
    expect(TURN_TEXT_MAX_CHARACTERS_V1).toBe(32_000);
  });

  test("is quiet until the budget is nearly spent", () => {
    expect(turnTextCounterVisibleV1("a short message")).toBe(false);
    expect(
      turnTextCounterVisibleV1("x".repeat(TURN_TEXT_COUNTER_FROM_V1)),
    ).toBe(true);
  });

  test("counts down, then counts the overflow", () => {
    expect(turnTextRemainingV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1))).toBe(
      0,
    );
    expect(
      turnTextRemainingV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 5)),
    ).toBe(-5);
  });

  test("refuses only past the limit, never at it", () => {
    expect(turnTextTooLongV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1))).toBe(
      false,
    );
    expect(turnTextTooLongV1("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 1))).toBe(
      true,
    );
  });
});
