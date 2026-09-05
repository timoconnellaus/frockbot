<script setup lang="ts">
// Deleting a Bot is Flock's authority — the directory it removes the
// registration from is Flock's — so the affordance is contributed into the Bot
// settings screen from here rather than reimplemented inside the Settings
// Package, which would have to reach across a Package seam for the store.
//
// The confirmation itself is `FlockOverlay`'s: one dialog, one focus trap, one
// mobile layout, and no second copy of the copy.
import { inject } from "vue";
import { flockWebDataKey } from "./state.js";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";

const flock = inject(flockWebDataKey);
if (!flock) throw new Error("Flock client data was not provided");
const shell = inject(frockBotWebDataKey);
if (!shell) throw new Error("FrockBot client data was not provided");
</script>
<template>
  <section v-if="shell.activeBotId" class="flock-danger-zone">
    <div>
      <strong>Delete Bot</strong>
      <small
        >This removes its conversation and Applets. It cannot be undone.</small
      >
    </div>
    <button
      type="button"
      class="flock-danger-zone__action"
      @click="flock.openDelete(shell.activeBotId)"
    >
      Delete Bot
    </button>
  </section>
</template>
<style scoped>
.flock-danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--frock-danger-border);
  border-radius: var(--frock-radius-surface, 12px);
  background: var(--frock-danger-surface);
}

.flock-danger-zone div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.flock-danger-zone small {
  color: var(--frock-text-muted);
}

.flock-danger-zone__action {
  flex: none;
  height: var(--frock-control-md, 32px);
  padding: 0 14px;
  border: 1px solid var(--frock-danger-strong);
  border-radius: 999px;
  background: var(--frock-danger-strong);
  color: var(--frock-on-accent);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.flock-danger-zone__action:hover {
  background: var(--frock-danger-text);
}
</style>
