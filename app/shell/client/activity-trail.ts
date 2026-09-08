/**
 * The comet trail: what a running Turn is actually doing, drawn as motion.
 *
 * A Turn can spend a minute streaming tokens and calling tools, and the thread
 * used to answer that with a stroke around the avatar that ticked once per
 * settled step. The stroke was honest but coarse — it said "a step happened"
 * and nothing about the rate work was arriving at. The trail is the finer
 * answer: particles stream off the right of the working Bot's avatar, and
 * their density is the Turn's own pace. Text arriving quickly is a dense
 * stream; a tool call starting or settling throws a burst; a reply landing is
 * a bright puff; a Turn waiting on the model still breathes, faintly, so the
 * app never reads as dead.
 *
 * This module is the whole mapping, kept out of the component so it is
 * testable without a canvas or a mounted Vue tree. It takes samples of what
 * the client already knows about the open Bot's Turn — the transcript's text,
 * its tool activity, its sends, its status — and returns the emission plan for
 * the moment between two samples. It never touches the DOM and never keeps a
 * clock of its own: the caller supplies `now`.
 */

/** The most particles a second the trail will ever ask for. */
export const ACTIVITY_TRAIL_MAX_RATE_V1 = 40;

/**
 * The floor while a Turn is open. A Turn waiting on a model that has not sent
 * a token yet is still working, and a trail that stops entirely reads as an
 * app that has crashed.
 */
export const ACTIVITY_TRAIL_TRICKLE_RATE_V1 = 6;

/** Silence longer than this is a wait, not a pause between chunks. */
export const ACTIVITY_TRAIL_QUIET_AFTER_MS_V1 = 1500;

/** How far back the chunk-rate average looks. */
export const ACTIVITY_TRAIL_RATE_WINDOW_MS_V1 = 1200;

/**
 * Characters of streamed text one particle stands for. At the cap above this
 * makes a full stream about 240 characters a second — faster than that and the
 * trail is simply saturated, which is the right thing for it to say.
 */
export const ACTIVITY_TRAIL_CHARACTERS_PER_PARTICLE_V1 = 6;

/** A tool call starting, or its result settling. */
export const ACTIVITY_TRAIL_TOOL_BURST_V1 = 15;

/** A payload reaching the person. */
export const ACTIVITY_TRAIL_SEND_BURST_V1 = 14;

/**
 * The most burst events one step will honour. A transcript that arrives in one
 * lump — a reconnect replaying a whole Turn — must not fire two hundred bursts
 * into the same frame.
 */
export const ACTIVITY_TRAIL_MAX_BURSTS_PER_STEP_V1 = 4;

/**
 * What the trail is saying, and the value the row carries as `data-state` so a
 * spec can assert on it.
 *
 * `running` is work arriving now, `waiting` is an open Turn that has gone
 * quiet, and `ended` is a settled Turn: nothing new is emitted and whatever is
 * on screen drains.
 */
export type ActivityTrailStateV1 = "running" | "waiting" | "ended";

/** One reading of the open Turn, as the client's projection has it. */
export interface ActivityTrailSampleV1 {
  /** Characters of assistant text in the Turn so far. Monotonic. */
  characters: number;
  /** Tool calls this Turn has started, settled or not. Monotonic. */
  toolStarts: number;
  /** Tool calls whose result has settled. Monotonic. */
  toolSettles: number;
  /** Payloads this Turn has delivered to the person. Monotonic. */
  sends: number;
  /**
   * The Turn's status, as the whole string rather than a union: only
   * `streaming` means the Turn is still going, and every other value —
   * including one a newer backend invents — is an ending. The trail is driven
   * off that one positive test, so it cannot be left emitting forever by a
   * status this file has never heard of.
   */
  status: string;
}

/** A one-off shot of particles, over and above the steady stream. */
export interface ActivityTrailBurstV1 {
  /** Particles to spawn at once. */
  count: number;
  /** Multiplier on the stream's rightward speed. */
  speed: number;
  /** Multiplier on the particles' opacity. Above one reads as a flash. */
  brightness: number;
}

/** What to emit for the moment between two samples. */
export interface ActivityTrailPlanV1 {
  /** Whether the emitter runs at all. A settled Turn emits nothing. */
  active: boolean;
  /** What the trail is saying, for the row's `data-state`. */
  state: ActivityTrailStateV1;
  /** Steady particles per second, `0 … ACTIVITY_TRAIL_MAX_RATE_V1`. */
  rate: number;
  /** Shots to fire once, now. */
  bursts: readonly ActivityTrailBurstV1[];
}

/** What the mapping remembers between two samples. Opaque to the caller. */
export interface ActivityTrailMemoryV1 {
  sample: ActivityTrailSampleV1;
  /** When something last changed, so a wait can be told from a pause. */
  lastEventAt: number;
  /** Recent character deltas, for the rate average. */
  window: ReadonlyArray<{ at: number; characters: number }>;
}

/**
 * A sample from the shapes the transcript already carries.
 *
 * Kept here rather than in the component so the Turn's vocabulary — a tool
 * that has not settled is `running`, the text is the whole bubble so far —
 * lives with the rule that reads it.
 */
export function activityTrailSampleV1(input: {
  text: string;
  toolStatuses: readonly string[];
  sends: number;
  status: string;
}): ActivityTrailSampleV1 {
  return {
    characters: input.text.length,
    toolStarts: input.toolStatuses.length,
    toolSettles: input.toolStatuses.filter((status) => status !== "running")
      .length,
    sends: input.sends,
    status: input.status,
  };
}

/** The memory a Turn starts with. Its first sample is the baseline. */
export function activityTrailBeginV1(
  sample: ActivityTrailSampleV1,
  now: number,
): ActivityTrailMemoryV1 {
  return { sample, lastEventAt: now, window: [] };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The plan for the moment between the remembered sample and this one.
 *
 * Deltas are floored at zero: a projection that replaces a Turn's text with a
 * shorter final version — a send superseding the model's own draft — is not a
 * negative amount of work, it is no work.
 */
export function activityTrailStepV1(
  memory: ActivityTrailMemoryV1,
  sample: ActivityTrailSampleV1,
  now: number,
): { memory: ActivityTrailMemoryV1; plan: ActivityTrailPlanV1 } {
  const characters = Math.max(0, sample.characters - memory.sample.characters);
  const startedTools = Math.max(
    0,
    sample.toolStarts - memory.sample.toolStarts,
  );
  const settledTools = Math.max(
    0,
    sample.toolSettles - memory.sample.toolSettles,
  );
  const delivered = Math.max(0, sample.sends - memory.sample.sends);

  if (sample.status !== "streaming") {
    return {
      memory: { sample, lastEventAt: memory.lastEventAt, window: [] },
      plan: { active: false, state: "ended", rate: 0, bursts: [] },
    };
  }

  const window = [...memory.window, { at: now, characters }].filter(
    (entry) => now - entry.at <= ACTIVITY_TRAIL_RATE_WINDOW_MS_V1,
  );
  const streamed = window.reduce((total, entry) => total + entry.characters, 0);
  const streamRate =
    streamed /
    (ACTIVITY_TRAIL_RATE_WINDOW_MS_V1 / 1000) /
    ACTIVITY_TRAIL_CHARACTERS_PER_PARTICLE_V1;

  const moved =
    characters > 0 || startedTools > 0 || settledTools > 0 || delivered > 0;
  const lastEventAt = moved ? now : memory.lastEventAt;
  const quiet = now - lastEventAt > ACTIVITY_TRAIL_QUIET_AFTER_MS_V1;

  const bursts: ActivityTrailBurstV1[] = [];
  for (let index = 0; index < startedTools + settledTools; index += 1) {
    bursts.push({
      count: ACTIVITY_TRAIL_TOOL_BURST_V1,
      speed: 1.8,
      brightness: 1.15,
    });
  }
  for (let index = 0; index < delivered; index += 1) {
    bursts.push({
      count: ACTIVITY_TRAIL_SEND_BURST_V1,
      speed: 1.2,
      brightness: 1.9,
    });
  }

  return {
    memory: { sample, lastEventAt, window },
    plan: {
      active: true,
      state: quiet ? "waiting" : "running",
      rate: clamp(
        Math.max(streamRate, ACTIVITY_TRAIL_TRICKLE_RATE_V1),
        0,
        ACTIVITY_TRAIL_MAX_RATE_V1,
      ),
      bursts: bursts.slice(0, ACTIVITY_TRAIL_MAX_BURSTS_PER_STEP_V1),
    },
  };
}
