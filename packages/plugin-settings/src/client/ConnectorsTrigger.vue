<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiIcon } from "@frockbot/client-ui";
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
    @click="surfaces.open('connections')"
  >
    <span class="settings-trigger__icon"><UiIcon name="plugins" /></span>
    Connectors
  </button>
</template>

<style scoped>
.settings-trigger {
  display: flex;
  width: 100%;
  height: 40px;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  font-size: var(--frock-text-md);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.settings-trigger:hover {
  background: var(--frock-fill-hover);
}

.settings-trigger:active {
  background: var(--frock-fill-pressed);
}

.settings-trigger__icon {
  display: grid;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}
</style>
