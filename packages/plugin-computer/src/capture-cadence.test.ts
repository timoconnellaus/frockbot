import { describe, expect, test } from "bun:test";
import {
  COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS,
  createComputerCaptureCadenceV1,
} from "./capture.js";

describe("the mid-Turn capture cadence", () => {
  test("captures the first Computer action of a Turn immediately", () => {
    const cadence = createComputerCaptureCadenceV1();
    expect(cadence.admit(1_000)).toBe(true);
  });

  test("files at most one capture per interval however busy the Turn", () => {
    const cadence = createComputerCaptureCadenceV1({ intervalMs: 2_000 });
    expect(cadence.admit(0)).toBe(true);
    // Twenty browser actions inside two seconds cost one screenshot.
    for (let at = 1; at < 2_000; at += 100) {
      expect(cadence.admit(at)).toBe(false);
    }
    expect(cadence.admit(2_000)).toBe(true);
    expect(cadence.admit(2_001)).toBe(false);
    expect(cadence.admit(4_000)).toBe(true);
  });

  test("a new Turn starts capturing again after a reset", () => {
    const cadence = createComputerCaptureCadenceV1({ intervalMs: 2_000 });
    expect(cadence.admit(0)).toBe(true);
    expect(cadence.admit(10)).toBe(false);
    cadence.reset();
    expect(cadence.admit(20)).toBe(true);
  });

  test("a clock that jumps backwards does not stop captures", () => {
    const cadence = createComputerCaptureCadenceV1({ intervalMs: 2_000 });
    expect(cadence.admit(10_000)).toBe(true);
    expect(cadence.admit(1_000)).toBe(true);
  });

  test("defaults to roughly two seconds", () => {
    expect(COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS).toBe(2_000);
    const cadence = createComputerCaptureCadenceV1();
    expect(cadence.admit(0)).toBe(true);
    expect(cadence.admit(COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS - 1)).toBe(
      false,
    );
    expect(cadence.admit(COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS)).toBe(true);
  });
});
