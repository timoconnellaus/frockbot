<script setup lang="ts">
/**
 * What a Bot looks like. The Flock's generated sheep recipe is the avatar.
 *
 * `working` draws the same activity ring the thread puts on the Bot it is
 * talking to, so a person reading one conversation can see another Bot still
 * going — on a list row and on a pinned tile alike. The sidebar knows only that
 * a Turn is running; the step count is the open conversation's to show, so a
 * ring out here pulses and does not tick.
 */
import { UiActivityRing } from "@frockbot/client-ui";
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
    <Transition name="flock-avatar-ring">
      <UiActivityRing v-if="working" :progress="0" />
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

.flock-avatar-ring-enter-active,
.flock-avatar-ring-leave-active {
  transition: opacity 420ms ease-out;
}

.flock-avatar-ring-enter-from,
.flock-avatar-ring-leave-to {
  opacity: 0;
}
</style>
