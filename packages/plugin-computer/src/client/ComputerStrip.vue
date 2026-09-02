<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { UiIcon } from "@frockbot/client-ui";
import { computed, inject, ref } from "vue";
import { computerKey, type ComputerState } from "../shared.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const busy = ref(false);
const state = computed(() => computer.value);
const screenshot = computed(() => state.value.screenshots?.[0]);
const phaseLabel = computed(() => state.value.phase.replaceAll("-", " "));

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
  <button
    type="button"
    class="computer-strip"
    :disabled="busy"
    :aria-label="`Open Computer, ${phaseLabel}`"
    @click="open"
  >
    <span class="computer-strip-capture">
      <img
        v-if="screenshot"
        :key="screenshot.contentHash"
        :src="screenshot.url"
        alt=""
        draggable="false"
      />
      <span v-else class="computer-strip-placeholder" aria-hidden="true">
        <UiIcon name="sparkle" size="sm" />
      </span>
    </span>
    <span class="computer-strip-phase">
      <span class="computer-strip-dot" :class="`phase-${state.phase}`" />
      <span>{{ phaseLabel }}</span>
    </span>
  </button>
</template>
