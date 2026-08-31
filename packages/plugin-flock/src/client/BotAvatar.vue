<script setup lang="ts">
/**
 * What a Bot looks like. The generated sheep is the default, and an uploaded
 * image replaces it — the same shape and size either way, so a swap never
 * shifts the layout around it.
 */
import { computed } from "vue";
import { flockWebDataKey } from "./state.js";
import SheepAvatar from "./SheepAvatar.vue";
import { inject } from "vue";
import type { SheepRecipeV1 } from "../shared.js";

const props = withDefaults(
  defineProps<{
    botId: string;
    sheep: SheepRecipeV1;
    label?: string;
    size?: "mini" | "small" | "large";
  }>(),
  { label: "Bot avatar", size: "small" },
);
const flock = inject(flockWebDataKey);
if (!flock) throw new Error("Flock client data was not provided");
const image = computed(() => {
  const avatar = flock.value.profiles[props.botId]?.avatar;
  return avatar
    ? `/api/bots/${encodeURIComponent(props.botId)}/avatar?v=${encodeURIComponent(avatar.digest)}`
    : undefined;
});
</script>
<template>
  <img
    v-if="image"
    class="flock-avatar"
    :class="`flock-avatar--${size}`"
    :src="image"
    :alt="label"
  />
  <SheepAvatar v-else :sheep="sheep" :label="label" :size="size" />
</template>
