<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiIcon } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";
import { packagePublisherStateKey } from "./state.js";

const surfaces = inject(clientSurfaceRegistryKey);
const state = inject(packagePublisherStateKey);
if (!surfaces || !state) {
  throw new Error("Package Publisher client services were not provided");
}
const publisher = state;
const summary = computed(() => {
  const history = publisher.value.history;
  if (!history) return "Not published yet";
  const active = history.activePackageRevision;
  if (active === undefined) return `${history.revisions.length} versions`;
  return `Version ${active} · in use`;
});

onMounted(() => publisher.value.load());
</script>

<template>
  <div class="publisher-section">
    <span class="publisher-section__icon" aria-hidden="true"
      ><UiIcon name="history"
    /></span>
    <span class="publisher-section__text">
      <strong>Published setup</strong>
      <small>{{ summary }}</small>
    </span>
    <UiButton type="button" @click="surfaces.open('package-publisher')">
      Open
    </UiButton>
  </div>
</template>

<style scoped>
.publisher-section {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.publisher-section__icon {
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

.publisher-section__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.publisher-section__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.publisher-section__text small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
</style>
