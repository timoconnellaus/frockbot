/**
 * The particle field behind `UiActivityTrail`.
 *
 * The component owns the canvas, the frame clock and the device pixel ratio;
 * this owns the particles — where they are born, how they move, when they stop
 * existing. Kept separate because the interesting failures are arithmetic
 * ones: a radius that goes negative and throws inside `arc`, a field that
 * grows without bound because nothing purges it, a stream that keeps emitting
 * after the Turn ended. All three are testable without a browser.
 *
 * Randomness is injected so a test can pin every particle it spawns.
 */

/** How fast the steady stream flows to the right, in CSS pixels a second. */
export const ACTIVITY_TRAIL_SPEED_V1 = 60;

/** The wobble's amplitude, in pixels a second at full swing. */
export const ACTIVITY_TRAIL_WOBBLE_V1 = 6;

/** Cycles of wobble per pixel travelled. */
export const ACTIVITY_TRAIL_WOBBLE_FREQUENCY_V1 = 0.08;

/**
 * The most particles the field will hold. A tab left in the background can
 * hand back a huge frame delta, and the spawn loop must not try to make a
 * thousand particles out of it.
 */
export const ACTIVITY_TRAIL_MAX_PARTICLES_V1 = 240;

/** The app's text colour and accent, as the trail blends between them. */
export const ACTIVITY_TRAIL_PALE_V1 = [244, 242, 246] as const;
export const ACTIVITY_TRAIL_ACCENT_V1 = [236, 56, 107] as const;

/**
 * How pink the trail is, `0 … 1`. The prototype settled on mostly pink: the
 * stream reads as the app's own accent rather than as dust.
 */
export const ACTIVITY_TRAIL_HUE_V1 = 0.7;

export interface ActivityTrailParticleV1 {
  x: number;
  y: number;
  /** Rightward speed, in pixels a second. */
  vx: number;
  /** Vertical drift, before the wobble. */
  vy: number;
  /** `1` at birth, down to `0`. */
  life: number;
  /** Life lost a second. */
  decay: number;
  /** Radius at birth. The drawn radius shrinks with life. */
  radius: number;
  /** `0 … 1`, this particle's place in the pale-to-accent blend. */
  tone: number;
  /** Opacity multiplier. A burst's particles are brighter. */
  brightness: number;
}

/**
 * One shot of particles as `UiActivityTrail` takes it: a burst, plus the
 * sequence number that makes it unique.
 *
 * The component is handed an append-only log rather than an event, because a
 * Vue prop is a value. It remembers the last `seq` it fired and fires
 * everything newer, so a re-render never replays a burst and a burst never
 * goes missing between two frames.
 */
export interface ActivityTrailBurstEventV1 {
  seq: number;
  count: number;
  speed: number;
  brightness: number;
}

export interface ActivityTrailFieldV1 {
  particles: ActivityTrailParticleV1[];
  /**
   * Fractional particles owed by the steady stream. A rate of six a second at
   * sixty frames a second spawns one particle every tenth of a second rather
   * than none, ever.
   */
  carry: number;
}

/** A source of `0 … 1` numbers. `Math.random` in the component. */
export type ActivityTrailRandomV1 = () => number;

export interface ActivityTrailGeometryV1 {
  /** Where particles are born: the avatar's right edge. */
  originX: number;
  /** The row's vertical middle. */
  centreY: number;
  /** The canvas width, in CSS pixels. Particles past it are purged. */
  width: number;
}

export function createActivityTrailFieldV1(): ActivityTrailFieldV1 {
  return { particles: [], carry: 0 };
}

function between(random: ActivityTrailRandomV1, low: number, high: number) {
  return low + random() * (high - low);
}

/**
 * One particle, born at the origin.
 *
 * `speed` and `brightness` are the burst's multipliers; the steady stream
 * passes one for both.
 */
export function spawnActivityTrailParticleV1(
  field: ActivityTrailFieldV1,
  input: {
    geometry: ActivityTrailGeometryV1;
    speed: number;
    brightness: number;
    random: ActivityTrailRandomV1;
  },
): void {
  if (field.particles.length >= ACTIVITY_TRAIL_MAX_PARTICLES_V1) return;
  const { random } = input;
  field.particles.push({
    x: input.geometry.originX,
    y: input.geometry.centreY + between(random, -3, 3),
    vx: ACTIVITY_TRAIL_SPEED_V1 * input.speed * between(random, 0.7, 1.3),
    vy: between(random, -8, 8),
    life: 1,
    decay: between(random, 0.8, 1.3),
    radius: between(random, 0.8, 2),
    tone: random(),
    brightness: input.brightness,
  });
}

/** A burst: `count` particles at once, all sharing its speed and brightness. */
export function burstActivityTrailFieldV1(
  field: ActivityTrailFieldV1,
  input: {
    count: number;
    speed: number;
    brightness: number;
    geometry: ActivityTrailGeometryV1;
    random: ActivityTrailRandomV1;
  },
): void {
  for (let index = 0; index < input.count; index += 1) {
    spawnActivityTrailParticleV1(field, {
      geometry: input.geometry,
      speed: input.speed,
      brightness: input.brightness,
      random: input.random,
    });
  }
}

/**
 * The field, one frame on.
 *
 * Spawning comes first so a burst fired this frame is visible in it, then
 * every particle moves, then the dead and the escaped are purged — before the
 * caller draws, so a frame never renders a particle with no life left in it.
 * `seconds` is clamped: a tab that was in the background hands back a delta of
 * minutes, and teleporting the whole field off the right edge is a worse
 * answer than one slow frame.
 */
export function advanceActivityTrailFieldV1(
  field: ActivityTrailFieldV1,
  input: {
    seconds: number;
    /** Steady particles a second. Zero once the Turn has ended. */
    rate: number;
    geometry: ActivityTrailGeometryV1;
    random: ActivityTrailRandomV1;
  },
): void {
  const seconds = Math.min(0.1, Math.max(0, input.seconds));

  field.carry += seconds * Math.max(0, input.rate);
  while (field.carry >= 1) {
    field.carry -= 1;
    spawnActivityTrailParticleV1(field, {
      geometry: input.geometry,
      speed: 1,
      brightness: 1,
      random: input.random,
    });
  }

  for (const particle of field.particles) {
    particle.x += particle.vx * seconds;
    particle.y +=
      particle.vy * seconds +
      Math.sin(particle.x * ACTIVITY_TRAIL_WOBBLE_FREQUENCY_V1) *
        ACTIVITY_TRAIL_WOBBLE_V1 *
        seconds;
    particle.life -= particle.decay * seconds;
  }

  field.particles = field.particles.filter(
    (particle) =>
      particle.life > 0 && particle.x <= input.geometry.width + particle.radius,
  );
}

/** The radius to draw a particle at. Never negative, so `arc` never throws. */
export function activityTrailRadiusV1(
  particle: ActivityTrailParticleV1,
): number {
  return Math.max(0.05, particle.radius * Math.max(0, particle.life));
}

/**
 * A particle's colour, blended between the app's text colour and its accent.
 *
 * `pale` and `accent` come from the theme's own custom properties where the
 * component can read them, and fall back to the tokens' values otherwise.
 */
export function activityTrailColourV1(
  particle: ActivityTrailParticleV1,
  palette: {
    pale: readonly [number, number, number];
    accent: readonly [number, number, number];
  } = { pale: ACTIVITY_TRAIL_PALE_V1, accent: ACTIVITY_TRAIL_ACCENT_V1 },
): string {
  const pinkness = Math.min(
    1,
    Math.max(0, ACTIVITY_TRAIL_HUE_V1 * 0.9 + (particle.tone - 0.5) * 0.4),
  );
  const channel = (index: 0 | 1 | 2) =>
    Math.round(
      palette.pale[index] +
        (palette.accent[index] - palette.pale[index]) * pinkness,
    );
  const alpha = Math.min(
    1,
    Math.max(0, particle.life) * 0.9 * particle.brightness,
  );
  return `rgba(${channel(0)},${channel(1)},${channel(2)},${alpha})`;
}

/**
 * A CSS colour as `[r, g, b]`, or `undefined` when it is not a form this
 * understands. Only the two shapes a theme custom property actually resolves
 * to — `#rrggbb` and `rgb(…)` — because the fallback is the token's own value
 * and a wrong guess would be worse than it.
 */
export function parseActivityTrailColourV1(
  value: string,
): [number, number, number] | undefined {
  const text = value.trim();
  const hex = /^#([\da-f]{6})$/i.exec(text);
  if (hex?.[1] !== undefined) {
    const digits = hex[1];
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (rgb?.[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    return [
      Math.round(Number(rgb[1])),
      Math.round(Number(rgb[2])),
      Math.round(Number(rgb[3])),
    ];
  }
  return undefined;
}
