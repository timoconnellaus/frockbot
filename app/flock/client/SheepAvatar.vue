<script setup lang="ts">
import { computed } from "vue";
import { sheepLayerIds, type SheepRecipeV1 } from "../shared.js";
const props = withDefaults(
  defineProps<{
    sheep: SheepRecipeV1;
    label?: string;
    size?: "mini" | "small" | "tile" | "large";
  }>(),
  { label: "Bot sheep", size: "small" },
);
const layers = computed(() => sheepLayerIds(props.sheep));
</script>
<template>
  <span
    class="flock-avatar"
    :class="`flock-avatar--${size}`"
    role="img"
    :aria-label="label"
  >
    <i
      v-for="layer in layers"
      :key="layer"
      class="flock-art"
      :class="`flock-art--${layer}`"
    />
  </span>
</template>
