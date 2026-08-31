<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
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
    <span aria-hidden="true">↺</span>Revisions
  </button>
</template>

<style scoped>
.publisher-trigger {
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

.publisher-trigger:hover {
  color: var(--frock-text);
  background: var(--frock-surface);
}

.publisher-trigger span {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface);
}
</style>
