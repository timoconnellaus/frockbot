<script setup lang="ts">
// The row in Application settings that names the Computer section.
//
// It renders one fact — how many machines are registered and how many are
// connected right now — and hands the rest to a surface, because a registry
// with pairing codes and revocation needs more room than the advanced block
// has. `connected` is the backend's arithmetic over `lastSeenAt`, never this
// component's: a laptop that stopped polling goes offline on its own, and a UI
// that guessed would be guessing about somebody's own computer.
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted } from "vue";
import { MACHINE_SURFACE_ID_V1 } from "./index.js";
import { machinesStateKey } from "./state.js";

const surfaces = inject(clientSurfaceRegistryKey);
const providedState = inject(machinesStateKey);
if (!surfaces || !providedState) {
  throw new Error("Registered machine client services were not provided");
}
const machines = providedState;
const anchorHref = settingsLinkV1({ anchor: "user-machines" });

const summary = computed(() => {
  const view = machines.value.view;
  if (!view) return "Not loaded yet";
  const live = view.machines.filter((machine) => machine.connected).length;
  if (view.machines.length === 0) return "No machines registered";
  return `${view.machines.length} registered · ${live} connected`;
});

onMounted(() => machines.value.load());
</script>

<template>
  <UiAnchor
    as="section"
    anchor="user-machines"
    label="Registered machines"
    :href="anchorHref"
    class="machines-section"
  >
    <span class="machines-section__icon" aria-hidden="true"
      ><UiIcon name="gear"
    /></span>
    <span class="machines-section__text">
      <strong>Registered machines</strong>
      <small>{{ summary }}</small>
    </span>
    <UiButton type="button" @click="surfaces.open(MACHINE_SURFACE_ID_V1)">
      Open
    </UiButton>
  </UiAnchor>
</template>

<style scoped>
.machines-section {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.machines-section__icon {
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

.machines-section__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.machines-section__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.machines-section__text small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
</style>
