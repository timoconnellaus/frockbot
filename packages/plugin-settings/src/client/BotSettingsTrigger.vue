<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { inject } from "vue";

const surfaces = inject(clientSurfaceRegistryKey);
const web = inject(frockBotWebDataKey);
if (!surfaces || !web)
  throw new Error("settings client services were not provided");
</script>

<template>
  <button
    v-if="web.settingsAvailable && web.activeBotId"
    class="bot-settings-trigger"
    type="button"
    title="Bot settings"
    aria-label="Bot settings"
    @click="surfaces.open('bot-settings')"
  >
    ⚙
  </button>
</template>

<style scoped>
.bot-settings-trigger {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--frock-border);
  border-radius: 50%;
  color: var(--frock-text-muted);
  background: var(--frock-surface);
  cursor: pointer;
}

.bot-settings-trigger:hover {
  color: var(--frock-action-primary-hover);
  border-color: var(--frock-border-focus);
}
</style>
