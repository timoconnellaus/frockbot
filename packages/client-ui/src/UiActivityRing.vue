<script setup lang="ts">
/**
 * A thin stroke drawn around an avatar while that Bot is working.
 *
 * It says two things without words: that something is still happening — it
 * breathes — and that steps are going by, because the stroke advances as the
 * caller's `progress` does. It never names what those steps were; the point of
 * the ring is that the transcript stays a conversation.
 *
 * The element positions itself over its parent, which must be `position:
 * relative`, and sits behind pointer events. `laps` draws a faint completed
 * ring behind the live one so a long Turn reads as further along without the
 * ring growing.
 */
const props = withDefaults(
  defineProps<{
    /** Fraction of the ring the live stroke draws, `0 … 1`. */
    progress?: number;
    /** Whether the ring breathes. A settled ring is still, and full. */
    running?: boolean;
    /** Faint rings behind the live stroke. Bounded by the caller. */
    laps?: number;
    /** What a screen reader is told this ring means. */
    label?: string;
  }>(),
  { progress: 0, running: true, laps: 0, label: "Working" },
);

/*
 * A 100-unit viewBox makes the geometry readable: the circumference below is
 * the only number the stroke maths needs, and `stroke-dasharray` splits it
 * into the drawn arc and the gap.
 */
const RADIUS = 46;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const arc = () => {
  const fraction = Math.min(1, Math.max(0, props.progress));
  // A ring with nothing drawn on it is a ring nobody sees, and the first
  // moment of a Turn — before a single step has settled — is exactly when
  // somebody needs to see one. The minimum arc is a fifth of the circle: big
  // enough to read as a moving head, small enough that the first real tick is
  // still an advance.
  const drawn = Math.max(0.2, fraction) * CIRCUMFERENCE;
  return `${drawn} ${CIRCUMFERENCE - drawn}`;
};
</script>

<template>
  <span
    class="ui-activity-ring"
    :class="{ 'ui-activity-ring--running': running }"
    role="status"
    :aria-label="label"
  >
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle
        v-if="laps > 0"
        class="ui-activity-ring__lap"
        cx="50"
        cy="50"
        :r="RADIUS"
      />
      <circle class="ui-activity-ring__track" cx="50" cy="50" :r="RADIUS" />
      <circle
        class="ui-activity-ring__arc"
        cx="50"
        cy="50"
        :r="RADIUS"
        :stroke-dasharray="arc()"
      />
    </svg>
  </span>
</template>

<style scoped>
.ui-activity-ring {
  position: absolute;

  /*
   * Clear of the avatar rather than on top of it: an avatar is usually a
   * rounded square, and a circle inscribed in its own box would run under the
   * art at the sides and vanish. `z-index` keeps it above a positioned avatar,
   * which is what the sidebar rows use.
   */
  z-index: 1;
  inset: -7px;
  pointer-events: none;
}

.ui-activity-ring svg {
  width: 100%;
  height: 100%;
  /* Twelve o'clock, so the stroke advances the way a clock hand does. */
  transform: rotate(-90deg);
  overflow: visible;
}

/*
 * The viewBox is 100 units across and the element is roughly 36px, so 6 units
 * of stroke is the ~2px hairline this is meant to be at the size an avatar is
 * actually drawn.
 */
.ui-activity-ring circle {
  fill: none;
  stroke-width: 6;
  stroke-linecap: round;
}

/* The unfilled part of the ring. Present enough to read as a circle. */
.ui-activity-ring__track {
  stroke: var(--frock-border-strong);
  opacity: 0.75;
}

.ui-activity-ring__lap {
  stroke: var(--frock-action-primary);
  opacity: 0.28;
}

.ui-activity-ring__arc {
  stroke: var(--frock-action-primary);
  /*
   * The tick itself: a step settles, `progress` changes, and the dash grows
   * into its new length rather than jumping there.
   */
  transition: stroke-dasharray 420ms ease-out;
}

.ui-activity-ring--running .ui-activity-ring__arc {
  animation: frock-ring-pulse 2200ms ease-in-out infinite;
}

@keyframes frock-ring-pulse {
  0%,
  100% {
    opacity: 0.7;
  }

  50% {
    opacity: 1;
  }
}

/*
 * Reduced motion keeps the information and drops the movement: the ring still
 * ticks forward for every step, it simply does not breathe or animate there.
 */
@media (prefers-reduced-motion: reduce) {
  .ui-activity-ring__arc {
    transition: none;
    animation: none;
    opacity: 1;
  }
}
</style>
