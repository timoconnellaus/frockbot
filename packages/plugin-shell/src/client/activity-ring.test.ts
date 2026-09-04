import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_RING_MAX_LAPS_V1,
  ACTIVITY_RING_SEGMENTS_V1,
  activityRingV1,
  type ActivityStepStatusV1,
} from "./activity-ring.js";

/** `count` settled steps, plus whatever is still in flight. */
function steps(settled: number, inFlight = 0): ActivityStepStatusV1[] {
  return [
    ...Array.from<ActivityStepStatusV1>({ length: settled }).fill("completed"),
    ...Array.from<ActivityStepStatusV1>({ length: inFlight }).fill("running"),
  ];
}

describe("the avatar's activity ring", () => {
  test("a Turn with nothing done yet still shows a ring", () => {
    // Liveness before progress: the ring is the answer to "is it paused?", so
    // it is drawn from the first moment of the Turn, empty and pulsing.
    const ring = activityRingV1({ toolStatuses: [], status: "streaming" });
    expect(ring.active).toBe(true);
    expect(ring.running).toBe(true);
    expect(ring.filled).toBe(0);
    expect(ring.progress).toBe(0);
  });

  test("a step that is still running has not ticked the ring", () => {
    const ring = activityRingV1({
      toolStatuses: steps(2, 1),
      status: "streaming",
    });
    expect(ring.steps).toBe(2);
    expect(ring.filled).toBe(2);
  });

  test("a failed step ticks like any other — it is a step that happened", () => {
    const ring = activityRingV1({
      toolStatuses: ["completed", "failed"],
      status: "streaming",
    });
    expect(ring.filled).toBe(2);
  });

  test("each settled step fills one more segment of the lap", () => {
    for (let settled = 0; settled < ACTIVITY_RING_SEGMENTS_V1; settled += 1) {
      const ring = activityRingV1({
        toolStatuses: steps(settled),
        status: "streaming",
      });
      expect(ring.filled).toBe(settled);
      expect(ring.progress).toBeCloseTo(settled / ACTIVITY_RING_SEGMENTS_V1);
      expect(ring.laps).toBe(0);
    }
  });

  test("a full lap leaves a faint ring behind and starts again", () => {
    const ring = activityRingV1({
      toolStatuses: steps(ACTIVITY_RING_SEGMENTS_V1 + 1),
      status: "streaming",
    });
    expect(ring.laps).toBe(1);
    expect(ring.filled).toBe(1);
  });

  test("a Turn of forty tool calls never grows a fortieth ring", () => {
    // The bound is the point: the ring reports that work is happening, not how
    // much, so past the last lap it loops inside the strokes it already has.
    const ring = activityRingV1({
      toolStatuses: steps(40),
      status: "streaming",
    });
    expect(ring.laps).toBe(ACTIVITY_RING_MAX_LAPS_V1);
    expect(ring.filled).toBeLessThan(ACTIVITY_RING_SEGMENTS_V1);
  });

  test("a settled Turn keeps no ring, however it ended", () => {
    for (const status of [
      "completed",
      "failed",
      "interrupted",
      "reconciliation-required",
    ] as const) {
      const ring = activityRingV1({ toolStatuses: steps(3), status });
      expect(ring.active).toBe(false);
      expect(ring.running).toBe(false);
    }
  });
});
