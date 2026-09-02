<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { UiIcon } from "@frockbot/client-ui";
import { computed, inject, ref } from "vue";
import { computerKey, type ComputerState } from "../shared.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const state = computed(() => computer.value);
const busy = ref(false);
const screenshot = computed(() => state.value.screenshots?.[0]);

async function open(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await state.value.openViewer();
  } catch {
    // The shared state already holds the visible failure.
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="computer-card">
    <button
      type="button"
      class="computer-screen computer-screen-thumbnail"
      :disabled="busy"
      aria-label="Open computer in full window"
      @click="open"
    >
      <img
        v-if="screenshot"
        :key="screenshot.contentHash"
        :src="screenshot.url"
        alt=""
        draggable="false"
      />
      <span v-else class="computer-placeholder">
        <UiIcon name="sparkle" size="lg" />
        <strong v-if="state.phase === 'unconfigured'"
          >Computer not configured</strong
        >
        <strong v-else-if="state.phase === 'provisioning'"
          >Preparing computer…</strong
        >
        <strong v-else-if="state.phase === 'updating'"
          >Updating computer…</strong
        >
        <strong v-else-if="state.phase === 'disconnected'"
          >Viewer disconnected</strong
        >
        <strong v-else>Persistent Computer</strong>
        <span class="computer-placeholder-message">{{ state.message }}</span>
      </span>
    </button>
  </section>
</template>
