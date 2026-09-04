/**
 * The activity ring: how much a running Turn has done, without saying so.
 *
 * A Turn can spend a minute making tool calls, and the thread used to answer
 * that with either nothing or a list of tool names. Neither is right — the
 * first reads as a paused app, the second puts the model's plumbing into a
 * conversation. The ring is the third answer: a stroke around the Bot's avatar
 * that pulses while the Turn runs and advances one segment for every step that
 * settles, so a person sees liveness and rough progress and reads no words at
 * all.
 *
 * This module is the whole rule, kept out of the component so it is testable
 * without mounting Vue.
 */

/** Segments in one lap of the ring. A step fills one. */
export const ACTIVITY_RING_SEGMENTS_V1 = 8;

/**
 * How many laps the ring will draw at once. A Turn making forty tool calls
 * must not grow a fortieth ring, so the lap beyond the first is the last one:
 * past it the ring keeps looping inside those two strokes.
 */
export const ACTIVITY_RING_MAX_LAPS_V1 = 1;

/** A step's state, as the Turn's tool activity reports it. */
export type ActivityStepStatusV1 = "running" | "completed" | "failed";

/**
 * A Turn's state, as the thread's message carries it.
 *
 * Deliberately the whole string rather than the union: only `streaming` means
 * the Turn is still going, and every other value — including one a newer Bot
 * invents — is an ending. The ring is drawn off that one positive test, so it
 * cannot be left spinning by a status this file has never heard of.
 */
export type ActivityTurnStatusV1 = string;

export interface ActivityRingViewV1 {
  /** Whether the ring is drawn at all. A settled Turn keeps none. */
  active: boolean;
  /** Whether the ring pulses. False once the Turn has settled. */
  running: boolean;
  /** Steps that have settled in this Turn. Unbounded, and never rendered. */
  steps: number;
  /** Filled segments of the current lap, `0 … ACTIVITY_RING_SEGMENTS_V1`. */
  filled: number;
  /** Faint laps completed behind the live stroke, capped. */
  laps: number;
  /** The fraction of the circumference the live stroke draws, `0 … 1`. */
  progress: number;
}

/**
 * The ring for one assistant line.
 *
 * A running Turn ticks: every settled tool call advances the stroke one
 * segment, and the lap that fills leaves a faint ring behind it — up to
 * {@link ACTIVITY_RING_MAX_LAPS_V1}, after which the ring simply loops. A Turn
 * that has settled draws no ring; the reply is the answer by then, and the
 * component fades the ring out on its way off screen.
 */
export function activityRingV1(input: {
  toolStatuses: readonly ActivityStepStatusV1[];
  status: ActivityTurnStatusV1;
}): ActivityRingViewV1 {
  const running = input.status === "streaming";
  const steps = input.toolStatuses.filter(
    (status) => status !== "running",
  ).length;
  if (!running) {
    return {
      active: false,
      running: false,
      steps,
      filled: 0,
      laps: 0,
      progress: 0,
    };
  }
  const filled = steps % ACTIVITY_RING_SEGMENTS_V1;
  const laps = Math.min(
    Math.floor(steps / ACTIVITY_RING_SEGMENTS_V1),
    ACTIVITY_RING_MAX_LAPS_V1,
  );
  return {
    active: true,
    running: true,
    steps,
    filled,
    laps,
    progress: filled / ACTIVITY_RING_SEGMENTS_V1,
  };
}
