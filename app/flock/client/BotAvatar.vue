<script setup lang="ts">
/**
 * What a Bot looks like. The Flock's generated sheep recipe is the avatar.
 *
 * `working` draws the same language the thread uses for the Bot it is talking
 * to — particles drifting off the avatar's right — so a person reading one
 * conversation can see another Bot still going, on a list row and on a pinned
 * tile alike.
 *
 * It is three CSS dots rather than the thread's canvas. A sidebar can hold
 * twenty rows, and twenty `requestAnimationFrame` loops running full particle
 * fields to say one bit each — "this Bot is busy" — is a cost the list should
 * not pay. Out here that is genuinely all there is to say: the sidebar knows a
 * Turn is running and nothing about its pace, which is the open
 * conversation's to show.
 */
import SheepAvatar from "./SheepAvatar.vue";
import type { SheepRecipeV1 } from "../shared.js";

withDefaults(
  defineProps<{
    botId: string;
    sheep: SheepRecipeV1;
    label?: string;
    size?: "mini" | "small" | "tile" | "large";
    working?: boolean;
  }>(),
  { label: "Bot avatar", size: "small", working: false },
);
</script>
<template>
  <span class="flock-avatar-slot">
    <SheepAvatar :sheep="sheep" :label="label" :size="size" />
    <Transition name="flock-avatar-drift">
      <span v-if="working" class="flock-avatar-drift" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </Transition>
  </span>
</template>

<style scoped>
.flock-avatar-slot {
  position: relative;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
}

/*
 * Clear of the avatar rather than over it, in the strip of row to its right.
 * `pointer-events` keeps the whole thing out of the way of the row's click,
 * and it lives inside the gap the row already leaves between the avatar and the
 * name, so it never runs under the text.
 */
.flock-avatar-drift {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 100%;
  width: 12px;
  height: 6px;
  margin-left: 2px;
  pointer-events: none;
  transform: translateY(-50%);
}

.flock-avatar-drift i {
  position: absolute;
  top: 2px;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--frock-action-primary);
  animation: frock-drift 2400ms linear infinite;
}

.flock-avatar-drift i:nth-child(2) {
  animation-delay: 800ms;
}

.flock-avatar-drift i:nth-child(3) {
  animation-delay: 1600ms;
}

/*
 * The same journey the thread's particles make — born at the avatar's edge,
 * out to the right, fading as they go — at a size a list can afford.
 */
@keyframes frock-drift {
  0% {
    opacity: 0;
    transform: translate(0, 0);
  }

  20% {
    opacity: 0.9;
  }

  100% {
    opacity: 0;
    transform: translate(10px, -2px);
  }
}

.flock-avatar-drift-enter-active,
.flock-avatar-drift-leave-active {
  transition: opacity 420ms ease-out;
}

.flock-avatar-drift-enter-from,
.flock-avatar-drift-leave-to {
  opacity: 0;
}

/*
 * Reduced motion keeps the fact and drops the movement: one still dot beside
 * the avatar, which is the whole of what this was saying.
 */
@media (prefers-reduced-motion: reduce) {
  .flock-avatar-drift i {
    animation: none;
    opacity: 0.9;
    transform: translate(4px, 0);
  }

  .flock-avatar-drift i:nth-child(2),
  .flock-avatar-drift i:nth-child(3) {
    display: none;
  }
}
</style>
