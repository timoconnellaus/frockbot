import { describe, expect, test } from "bun:test";
import { dialogFocusWrapTarget } from "./dialog-focus.js";

describe("Flock dialog focus trap", () => {
  test("wraps forward and reverse Tab only at dialog boundaries", () => {
    const first = { id: "first" };
    const middle = { id: "middle" };
    const last = { id: "last" };
    const controls = [first, middle, last];
    expect(dialogFocusWrapTarget(controls, last, false)).toBe(first);
    expect(dialogFocusWrapTarget(controls, first, true)).toBe(last);
    expect(dialogFocusWrapTarget(controls, middle, false)).toBeUndefined();
    expect(dialogFocusWrapTarget([], null, false)).toBeUndefined();
  });
});
