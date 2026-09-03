<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { UiIcon } from "@frockbot/client-ui";
import { computed, inject, ref } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computerKey, type ComputerState } from "../shared.ts";
import { COMPUTER_COLD_PROVISION_EXPECTATION } from "../protocol.ts";
import {
  computerProgressElapsedMs,
  computerProgressFrame,
  computerProgressRunKind,
} from "./progress.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const state = computed(() => computer.value);
const busy = ref(false);
// No Bot, no Computer card. The client machine seeds a placeholder projection
// before any Bot exists, and rendering it told a brand-new User about the
// Computer of a Bot they had not created yet.
const shell = inject(frockBotWebDataKey, undefined);
const hasBot = computed(() => Boolean(shell?.value.activeBotId));
const screenshot = computed(() => state.value.screenshots?.[0]);
// A card that says there is no Computer opens nothing: a full-screen modal
// repeating the same sentence is a click that costs the User a step and
// answers nothing.
const unconfigured = computed(() => state.value.phase === "unconfigured");
const opening = computed(
  () =>
    state.value.phase === "provisioning" || state.value.phase === "updating",
);
const progressRunKind = computed(() => computerProgressRunKind(state.value));
const openingHeading = computed(() => {
  switch (progressRunKind.value) {
    case "cold-provision":
      return "Setting up your computer for the first time";
    case "resumed-provision":
      return "Resuming computer setup";
    case "update":
      return "Updating your computer";
    case "warm-wake":
      return "Preparing computer…";
  }
});
const setupExpectation = computed(() =>
  progressRunKind.value === "cold-provision"
    ? COMPUTER_COLD_PROVISION_EXPECTATION
    : undefined,
);
const progressPhaseLabel = computed(
  () =>
    state.value.progress?.provisioning?.label ??
    state.value.progress?.steps.find((step) => step.status === "active")
      ?.label ??
    state.value.message,
);
const progressFrame = computed(() =>
  computerProgressFrame({
    projection: state.value,
    elapsedMs: computerProgressElapsedMs(state.value.progress, Date.now()),
  }),
);
const progressValueNow = computed(() => {
  const fraction = progressFrame.value.fraction;
  return fraction === undefined ? undefined : Math.round(fraction * 100);
});
const progressAnimationKey = computed(() => {
  const progress = state.value.progress;
  return progress
    ? [
        progress.startedAt,
        progress.updatedAt,
        progress.index,
        progress.provisioning?.index ?? "connect",
      ].join(":")
    : "indeterminate";
});
const progressFillStyle = computed(() => {
  const frame = progressFrame.value;
  if (frame.fraction === undefined || frame.nextBoundary === undefined) {
    return undefined;
  }
  return {
    "--computer-progress-from": String(frame.fraction),
    "--computer-progress-to": String(frame.nextBoundary),
    "--computer-progress-duration": `${frame.remainingMs ?? 0}ms`,
  };
});
const progressAriaLabel = computed(
  () => `${openingHeading.value}: ${progressPhaseLabel.value}`,
);

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
  <section v-if="hasBot" class="computer-card">
    <button
      type="button"
      class="computer-screen computer-screen-thumbnail"
      :disabled="busy || unconfigured"
      aria-label="Open computer in full window"
      @click="open"
    >
      <img
        v-if="screenshot && !opening"
        :key="screenshot.contentHash"
        :src="screenshot.url"
        alt=""
        draggable="false"
      />
      <span v-else class="computer-placeholder">
        <template v-if="opening">
          <strong>{{ openingHeading }}</strong>
          <span v-if="setupExpectation" class="computer-setup-expectation">
            {{ setupExpectation }}
          </span>
          <span
            class="computer-progress-phase"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ progressPhaseLabel }}
          </span>
          <span
            class="computer-progress-track computer-progress-track-compact"
            :class="{
              'is-determinate': progressValueNow !== undefined,
              'is-css-timed': progressValueNow !== undefined,
            }"
            role="progressbar"
            :aria-label="progressAriaLabel"
            :aria-valuemin="progressValueNow === undefined ? undefined : 0"
            :aria-valuemax="progressValueNow === undefined ? undefined : 100"
            :aria-valuenow="progressValueNow"
          >
            <span :key="progressAnimationKey" :style="progressFillStyle" />
          </span>
        </template>
        <template v-else>
          <UiIcon name="sparkle" size="lg" />
          <strong v-if="state.phase === 'unconfigured'">No computer</strong>
          <strong v-else-if="state.phase === 'disconnected'"
            >Viewer disconnected</strong
          >
          <strong v-else>Computer</strong>
          <span class="computer-placeholder-message">{{ state.message }}</span>
        </template>
      </span>
    </button>
  </section>
</template>
