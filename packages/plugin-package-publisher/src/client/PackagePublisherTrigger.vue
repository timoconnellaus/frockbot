<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiIcon } from "@frockbot/client-ui";
import { inject } from "vue";

const surfaces = inject(clientSurfaceRegistryKey);
if (!surfaces) throw new Error("client surface registry was not provided");
</script>

<template>
  <button
    class="publisher-trigger"
    type="button"
    @click="surfaces.open('package-publisher')"
  >
    <span class="publisher-trigger__icon"><UiIcon name="history" /></span>
    Revisions
  </button>
</template>

<style scoped>
.publisher-trigger {
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

.publisher-trigger:hover {
  background: var(--frock-fill-hover);
}

.publisher-trigger:active {
  background: var(--frock-fill-pressed);
}

.publisher-trigger__icon {
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
