<script setup lang="ts">
/**
 * A loading placeholder that keeps the final layout's footprint so content
 * does not jump when it arrives. Compose several to sketch a row or a card.
 */
withDefaults(
  defineProps<{
    width?: string;
    height?: string;
    shape?: "text" | "block" | "circle";
  }>(),
  { width: "100%", height: undefined, shape: "text" },
);
</script>

<template>
  <span
    class="ui-skeleton"
    :class="`ui-skeleton--${shape}`"
    :style="{ width, height }"
    aria-hidden="true"
  />
</template>

<style scoped>
.ui-skeleton {
  position: relative;
  display: block;
  overflow: hidden;
  flex: 0 0 auto;
  background: var(--frock-skeleton);
}

.ui-skeleton--text {
  height: 0.75em;
  border-radius: 4px;
}

.ui-skeleton--block {
  height: var(--frock-control-md);
  border-radius: var(--frock-radius-control);
}

.ui-skeleton--circle {
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  border-radius: 999px;
}

.ui-skeleton::after {
  position: absolute;
  inset: 0;
  content: "";
  background: linear-gradient(
    90deg,
    transparent,
    var(--frock-skeleton-shine),
    transparent
  );
  animation: frock-shimmer 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .ui-skeleton::after {
    animation: none;
  }
}
</style>
