<script setup lang="ts">
/**
 * A comet trail streaming off the right of a working Bot's avatar.
 *
 * It says two things without words: that the Bot is working, and how hard —
 * the density of the stream is the rate work is actually arriving at, and a
 * burst is a discrete thing having happened. It never names what happened; the
 * point is that the transcript stays a conversation.
 *
 * The caller owns the meaning. This takes a `rate` in particles a second and a
 * log of `bursts`, and draws them. What maps a Turn's chunks, tool calls and
 * sends onto those numbers lives with the Turn, in the shell's
 * `activity-trail.ts`.
 *
 * Bursts arrive as an append-only log rather than an event, because a Vue
 * prop is a value: the component remembers the last sequence number it fired
 * and fires everything newer, so a re-render never replays a burst and a
 * burst never goes missing between frames.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ACTIVITY_TRAIL_ACCENT_V1,
  ACTIVITY_TRAIL_PALE_V1,
  activityTrailColourV1,
  activityTrailRadiusV1,
  advanceActivityTrailFieldV1,
  burstActivityTrailFieldV1,
  createActivityTrailFieldV1,
  parseActivityTrailColourV1,
  type ActivityTrailBurstEventV1,
  type ActivityTrailGeometryV1,
} from "./activity-trail-field.js";

const props = withDefaults(
  defineProps<{
    /** Steady particles a second. Zero drains the field and stops. */
    rate?: number;
    /** Append-only; everything past the last fired `seq` is fired. */
    bursts?: readonly ActivityTrailBurstEventV1[];
    /**
     * What the trail is saying — `running`, `waiting`, or `ended`. Drawn only
     * as a data attribute, for specs and for anyone styling around it.
     */
    state?: string;
    /** Where particles are born, measured from the canvas's left edge. */
    originX?: number;
  }>(),
  { rate: 0, bursts: () => [], state: "running", originX: 6 },
);

const canvas = ref<HTMLCanvasElement | null>(null);
const field = createActivityTrailFieldV1();
let frame = 0;
let lastFrameAt = 0;
let firedSeq = -1;
let palette = {
  pale: ACTIVITY_TRAIL_PALE_V1 as readonly [number, number, number],
  accent: ACTIVITY_TRAIL_ACCENT_V1 as readonly [number, number, number],
};

/**
 * Whether the person asked for less motion. Read once at mount and watched, so
 * flipping the setting stops a trail that is already running.
 */
const stillness =
  typeof window === "undefined" || window.matchMedia === undefined
    ? null
    : window.matchMedia("(prefers-reduced-motion: reduce)");
const still = ref(stillness?.matches === true);

function geometryOf(element: HTMLCanvasElement): ActivityTrailGeometryV1 {
  const box = element.getBoundingClientRect();
  return {
    originX: props.originX,
    centreY: box.height / 2,
    width: box.width,
  };
}

/**
 * The canvas's backing store, matched to the device's pixels.
 *
 * A canvas sized only in CSS is drawn at one device pixel per CSS pixel and a
 * two-pixel particle is a smear on a retina screen. The transform means every
 * coordinate below stays in CSS pixels.
 */
function resize(): void {
  const element = canvas.value;
  if (element === null) return;
  const box = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const width = Math.max(1, Math.round(box.width * ratio));
  const height = Math.max(1, Math.round(box.height * ratio));
  if (element.width !== width) element.width = width;
  if (element.height !== height) element.height = height;
  const context = element.getContext("2d");
  if (context !== null) context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

/** The theme's own colours, where they resolve to something this can parse. */
function readPalette(): void {
  const element = canvas.value;
  if (element === null || typeof window === "undefined") return;
  const computed = window.getComputedStyle(element);
  const pale = parseActivityTrailColourV1(
    computed.getPropertyValue("--frock-text"),
  );
  const accent = parseActivityTrailColourV1(
    computed.getPropertyValue("--frock-action-primary"),
  );
  palette = {
    pale: pale ?? ACTIVITY_TRAIL_PALE_V1,
    accent: accent ?? ACTIVITY_TRAIL_ACCENT_V1,
  };
}

function draw(element: HTMLCanvasElement): void {
  const context = element.getContext("2d");
  if (context === null) return;
  const box = element.getBoundingClientRect();
  context.clearRect(0, 0, box.width, box.height);
  for (const particle of field.particles) {
    context.fillStyle = activityTrailColourV1(particle, palette);
    context.beginPath();
    context.arc(
      particle.x,
      particle.y,
      activityTrailRadiusV1(particle),
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

/** Bursts the caller has added since the last time this ran. */
function fireNewBursts(geometry: ActivityTrailGeometryV1): boolean {
  let fired = false;
  for (const burst of props.bursts) {
    if (burst.seq <= firedSeq) continue;
    firedSeq = burst.seq;
    burstActivityTrailFieldV1(field, {
      count: burst.count,
      speed: burst.speed,
      brightness: burst.brightness,
      geometry,
      random: Math.random,
    });
    fired = true;
  }
  return fired;
}

function tick(at: number): void {
  frame = 0;
  const element = canvas.value;
  if (element === null) return;
  const seconds = lastFrameAt === 0 ? 0 : (at - lastFrameAt) / 1000;
  lastFrameAt = at;
  resize();
  const geometry = geometryOf(element);
  fireNewBursts(geometry);
  advanceActivityTrailFieldV1(field, {
    seconds,
    rate: props.rate,
    geometry,
    random: Math.random,
  });
  draw(element);
  // The loop stops the moment there is nothing left to say: a settled Turn
  // drains its particles and then costs no frames at all.
  if (props.rate > 0 || field.particles.length > 0) {
    frame = window.requestAnimationFrame(tick);
  } else {
    lastFrameAt = 0;
  }
}

function start(): void {
  if (still.value || frame !== 0 || typeof window === "undefined") return;
  frame = window.requestAnimationFrame(tick);
}

function stop(): void {
  if (frame !== 0) window.cancelAnimationFrame(frame);
  frame = 0;
  lastFrameAt = 0;
}

/**
 * Reduced motion keeps the information and drops the movement: no loop, and
 * one still puff drawn where a burst would have been, replacing the last. It
 * is a mark that something happened, which is what the animation was for.
 */
function puff(): void {
  const element = canvas.value;
  if (element === null) return;
  resize();
  const geometry = geometryOf(element);
  field.particles = [];
  const latest = props.bursts.at(-1);
  burstActivityTrailFieldV1(field, {
    count: 8,
    speed: latest?.speed ?? 1,
    brightness: latest?.brightness ?? 1,
    geometry,
    random: Math.random,
  });
  // Spread the puff along the row so it reads as a trail rather than a dot,
  // without a frame ever running.
  field.particles.forEach((particle, index) => {
    particle.x = geometry.originX + index * 7;
    particle.life = 1 - index * 0.08;
  });
  draw(element);
}

onMounted(() => {
  readPalette();
  if (still.value) {
    firedSeq = props.bursts.at(-1)?.seq ?? -1;
    puff();
  } else {
    start();
  }
  stillness?.addEventListener("change", onStillnessChange);
});

onBeforeUnmount(() => {
  stop();
  stillness?.removeEventListener("change", onStillnessChange);
});

function onStillnessChange(event: MediaQueryListEvent): void {
  still.value = event.matches;
  if (still.value) {
    stop();
    puff();
  } else {
    start();
  }
}

watch(
  () => [props.rate, props.bursts] as const,
  () => {
    if (still.value) {
      const latest = props.bursts.at(-1)?.seq ?? -1;
      if (latest > firedSeq) {
        firedSeq = latest;
        puff();
      }
      return;
    }
    start();
  },
);
</script>

<template>
  <span class="ui-activity-trail" :data-state="state" aria-hidden="true">
    <canvas ref="canvas" />
  </span>
</template>

<style scoped>
.ui-activity-trail {
  position: relative;
  display: block;
  min-width: 0;
  height: 100%;
  flex: 1 1 auto;
  pointer-events: none;
}

.ui-activity-trail canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
