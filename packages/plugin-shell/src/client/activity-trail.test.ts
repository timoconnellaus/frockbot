import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_TRAIL_CHARACTERS_PER_PARTICLE_V1,
  ACTIVITY_TRAIL_MAX_BURSTS_PER_STEP_V1,
  ACTIVITY_TRAIL_MAX_RATE_V1,
  ACTIVITY_TRAIL_QUIET_AFTER_MS_V1,
  ACTIVITY_TRAIL_SEND_BURST_V1,
  ACTIVITY_TRAIL_TOOL_BURST_V1,
  ACTIVITY_TRAIL_TRICKLE_RATE_V1,
  activityTrailBeginV1,
  activityTrailSampleV1,
  activityTrailStepV1,
  type ActivityTrailSampleV1,
} from "./activity-trail.js";

function sample(
  overrides: Partial<ActivityTrailSampleV1> = {},
): ActivityTrailSampleV1 {
  return {
    characters: 0,
    toolStarts: 0,
    toolSettles: 0,
    sends: 0,
    status: "streaming",
    ...overrides,
  };
}

describe("what the transcript says a Turn is doing", () => {
  test("a tool with no result yet has started but not settled", () => {
    const reading = activityTrailSampleV1({
      text: "half a rep",
      toolStatuses: ["completed", "running"],
      sends: 1,
      status: "streaming",
    });
    expect(reading.characters).toBe("half a rep".length);
    expect(reading.toolStarts).toBe(2);
    expect(reading.toolSettles).toBe(1);
    expect(reading.sends).toBe(1);
  });
});

describe("the comet trail's emission plan", () => {
  test("a Turn that has produced nothing yet still emits", () => {
    // Liveness before pace: the first moment of a Turn is exactly when a
    // person needs to see that something is happening.
    const memory = activityTrailBeginV1(sample(), 0);
    const { plan } = activityTrailStepV1(memory, sample(), 16);
    expect(plan.active).toBe(true);
    expect(plan.state).toBe("running");
    expect(plan.rate).toBe(ACTIVITY_TRAIL_TRICKLE_RATE_V1);
    expect(plan.bursts).toEqual([]);
  });

  test("the density tracks how fast text is arriving", () => {
    // Two hundred characters inside the averaging window is well above the
    // trickle and below saturation, so the rate is the chunk rate itself.
    let memory = activityTrailBeginV1(sample(), 0);
    const stepped = activityTrailStepV1(
      memory,
      sample({ characters: 200 }),
      200,
    );
    memory = stepped.memory;
    expect(stepped.plan.rate).toBeGreaterThan(ACTIVITY_TRAIL_TRICKLE_RATE_V1);
    expect(stepped.plan.rate).toBeLessThan(ACTIVITY_TRAIL_MAX_RATE_V1);
    expect(stepped.plan.rate).toBeCloseTo(
      200 / 1.2 / ACTIVITY_TRAIL_CHARACTERS_PER_PARTICLE_V1,
      5,
    );

    // Half as much text in the same window is half the density.
    const slower = activityTrailStepV1(
      activityTrailBeginV1(sample(), 0),
      sample({ characters: 100 }),
      200,
    );
    expect(slower.plan.rate).toBeCloseTo(stepped.plan.rate / 2, 5);
  });

  test("a torrent of text saturates rather than running away", () => {
    const { plan } = activityTrailStepV1(
      activityTrailBeginV1(sample(), 0),
      sample({ characters: 100_000 }),
      100,
    );
    expect(plan.rate).toBe(ACTIVITY_TRAIL_MAX_RATE_V1);
  });

  test("a tool call starting throws a burst, and settling throws another", () => {
    let memory = activityTrailBeginV1(sample(), 0);
    const started = activityTrailStepV1(memory, sample({ toolStarts: 1 }), 100);
    memory = started.memory;
    expect(started.plan.bursts).toEqual([
      { count: ACTIVITY_TRAIL_TOOL_BURST_V1, speed: 1.8, brightness: 1.15 },
    ]);

    const settled = activityTrailStepV1(
      memory,
      sample({ toolStarts: 1, toolSettles: 1 }),
      200,
    );
    expect(settled.plan.bursts).toHaveLength(1);
    expect(settled.plan.bursts[0]?.count).toBe(ACTIVITY_TRAIL_TOOL_BURST_V1);
  });

  test("a send landing is a brighter puff than a tool call", () => {
    const { plan } = activityTrailStepV1(
      activityTrailBeginV1(sample(), 0),
      sample({ sends: 1 }),
      100,
    );
    expect(plan.bursts).toEqual([
      { count: ACTIVITY_TRAIL_SEND_BURST_V1, speed: 1.2, brightness: 1.9 },
    ]);
  });

  test("a whole Turn arriving at once does not fire a hundred bursts", () => {
    // What a reconnect looks like: the projection replays every step of a Turn
    // in one update. The trail says "a lot just happened", not two hundred
    // separate shots into one frame.
    const { plan } = activityTrailStepV1(
      activityTrailBeginV1(sample(), 0),
      sample({ toolStarts: 60, toolSettles: 60, sends: 20 }),
      100,
    );
    expect(plan.bursts).toHaveLength(ACTIVITY_TRAIL_MAX_BURSTS_PER_STEP_V1);
  });

  test("an open Turn that has gone quiet trickles rather than stopping", () => {
    let memory = activityTrailBeginV1(sample(), 0);
    memory = activityTrailStepV1(
      memory,
      sample({ characters: 40 }),
      100,
    ).memory;

    const soon = activityTrailStepV1(
      memory,
      sample({ characters: 40 }),
      100 + ACTIVITY_TRAIL_QUIET_AFTER_MS_V1,
    );
    expect(soon.plan.state).toBe("running");

    const later = activityTrailStepV1(
      memory,
      sample({ characters: 40 }),
      101 + ACTIVITY_TRAIL_QUIET_AFTER_MS_V1,
    );
    expect(later.plan.active).toBe(true);
    expect(later.plan.state).toBe("waiting");
    expect(later.plan.rate).toBe(ACTIVITY_TRAIL_TRICKLE_RATE_V1);
    expect(later.plan.bursts).toEqual([]);
  });

  test("a settled Turn emits nothing at all", () => {
    for (const status of [
      "completed",
      "aborted",
      "error",
      "interrupted",
      "reconciliation-required",
      "a status this file has never heard of",
    ]) {
      const { plan } = activityTrailStepV1(
        activityTrailBeginV1(sample(), 0),
        sample({ characters: 400, toolStarts: 3, toolSettles: 3, status }),
        100,
      );
      expect(plan.active).toBe(false);
      expect(plan.state).toBe("ended");
      expect(plan.rate).toBe(0);
      expect(plan.bursts).toEqual([]);
    }
  });

  test("text the Turn takes back is no work rather than negative work", () => {
    // A delivered send supersedes the model's own longer draft, so the
    // transcript's text can shrink between two samples.
    const memory = activityTrailBeginV1(sample({ characters: 500 }), 0);
    const { plan } = activityTrailStepV1(
      memory,
      sample({ characters: 4, sends: 1 }),
      100,
    );
    expect(plan.rate).toBe(ACTIVITY_TRAIL_TRICKLE_RATE_V1);
    expect(plan.bursts).toHaveLength(1);
  });

  test("the rate window forgets text that arrived long ago", () => {
    let memory = activityTrailBeginV1(sample(), 0);
    memory = activityTrailStepV1(
      memory,
      sample({ characters: 400 }),
      100,
    ).memory;
    const { plan } = activityTrailStepV1(
      memory,
      sample({ characters: 400 }),
      100 + ACTIVITY_TRAIL_QUIET_AFTER_MS_V1 + 1,
    );
    expect(plan.rate).toBe(ACTIVITY_TRAIL_TRICKLE_RATE_V1);
  });
});
