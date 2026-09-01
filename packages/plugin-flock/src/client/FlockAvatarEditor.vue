<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject } from "vue";
import BotAvatar from "./BotAvatar.vue";
import { flockWebDataKey } from "./state.js";

const flock = inject(flockWebDataKey);
const shell = inject(frockBotWebDataKey);
if (!flock || !shell) throw new Error("Flock client data was not provided");
flock.value.bindShell(shell);

const identity = computed(() =>
  shell.value.activeBotId
    ? flock.value.identities[shell.value.activeBotId]
    : undefined,
);
const label = computed(
  () => `${shell.value.botSettings?.profile.name ?? "This Bot"} avatar`,
);
</script>

<template>
  <div v-if="identity && shell.activeBotId" class="flock-avatar-editor">
    <BotAvatar
      :bot-id="shell.activeBotId"
      :sheep="identity.sheep"
      :label="label"
      size="large"
    />
    <UiButton type="button" variant="ghost" @click="flock.openEdit">
      Change
    </UiButton>
  </div>
</template>

<style scoped>
.flock-avatar-editor {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
</style>
