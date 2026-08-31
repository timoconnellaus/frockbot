<script setup lang="ts">
import { computed, inject } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { flockWebDataKey } from "./state.js";
import BotAvatar from "./BotAvatar.vue";
const flock = inject(flockWebDataKey);
const shell = inject(frockBotWebDataKey);
if (!flock || !shell) throw new Error("Flock client data was not provided");
flock.value.bindShell(shell);
const identity = computed(() =>
  shell.value.activeBotId
    ? flock.value.identities[shell.value.activeBotId]
    : undefined,
);
</script>
<template>
  <button
    v-if="identity"
    class="flock-identity-button"
    type="button"
    title="Tailor sheep"
    aria-label="Tailor sheep"
    @click="flock.openEdit"
  >
    <BotAvatar
      :bot-id="shell.activeBotId!"
      :sheep="identity.sheep"
      :label="`${shell.botSettings?.profile.name ?? 'This Bot'} avatar`"
    /></button
  ><span v-else>⌁</span>
</template>
