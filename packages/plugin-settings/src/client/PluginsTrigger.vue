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
    v-if="web.connectionsAvailable"
    class="settings-trigger"
    type="button"
    @click="surfaces.open('plugins')"
  >
    <span aria-hidden="true">⊙</span>Plugins
  </button>
</template>

<style scoped>
.settings-trigger {
  display: flex;
  width: 100%;
  height: 42px;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  border-top: 1px solid var(--frock-border);
  color: var(--frock-text-muted);
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.settings-trigger:hover {
  color: var(--frock-text);
  background: var(--frock-surface);
}

.settings-trigger span {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface);
}
</style>
