<script setup lang="ts">
import { computed } from "vue";
import { uiIconPaths, type UiIconName } from "./icons.js";

const props = withDefaults(
  defineProps<{
    name: UiIconName;
    /** Rendered box in CSS pixels. Defaults to the medium icon token. */
    size?: number | "sm" | "md" | "lg";
    /** Stroke width in 24-unit viewBox units. */
    weight?: number;
  }>(),
  { size: "md", weight: 1.75 },
);

const dimension = computed(() =>
  typeof props.size === "number"
    ? `${props.size}px`
    : `var(--frock-icon-${props.size})`,
);
const segments = computed(() => uiIconPaths[props.name]);
const filled = computed(() => props.name === "stop");
</script>

<template>
  <svg
    class="ui-icon"
    :style="{ width: dimension, height: dimension }"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="weight"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(segment, index) in segments" :key="index" :d="segment" />
  </svg>
</template>

<style scoped>
.ui-icon {
  display: block;
  flex: 0 0 auto;
}
</style>
