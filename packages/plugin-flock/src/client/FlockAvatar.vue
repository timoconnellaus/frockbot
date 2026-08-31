<script setup lang="ts">
import { computed, inject } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { flockWebDataKey } from "./state.js";
import SheepAvatar from "./SheepAvatar.vue";

/**
 * The active Bot's sheep, rendered beside each assistant message. The shell
 * owns the slot and the animation; the Flock Package owns what a Bot looks
 * like, so the shell never imports this Package.
 */
const flock = inject(flockWebDataKey);
const shell = inject(frockBotWebDataKey);
if (!flock || !shell) throw new Error("Flock client data was not provided");
const identity = computed(() =>
  shell.value.activeBotId
    ? flock.value.identities[shell.value.activeBotId]
    : undefined,
);
const name = computed(
  () => shell.value.botSettings?.profile.name ?? "This Bot",
);
</script>

<template>
  <SheepAvatar
    v-if="identity"
    :sheep="identity.sheep"
    size="mini"
    :label="name"
  />
</template>
