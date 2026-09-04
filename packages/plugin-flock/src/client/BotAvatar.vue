<script setup lang="ts">
/**
 * What a Bot looks like. The Flock's generated sheep recipe is the avatar.
 */
import SheepAvatar from "./SheepAvatar.vue";
import type { SheepRecipeV1 } from "../shared.js";

const props = withDefaults(
  defineProps<{
    botId: string;
    sheep: SheepRecipeV1;
    label?: string;
    size?: "mini" | "small" | "tile" | "large";
  }>(),
  { label: "Bot avatar", size: "small" },
);
</script>
<template>
  <SheepAvatar :sheep="sheep" :label="label" :size="size" />
</template>
