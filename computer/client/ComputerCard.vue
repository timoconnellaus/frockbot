<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { UiIcon } from "@frockbot/client-ui";
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  watchEffect,
} from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computerKey, type ComputerState } from "../shared.ts";
import { COMPUTER_COLD_PROVISION_EXPECTATION } from "../protocol.ts";
import {
  computerProgressElapsedMs,
  computerProgressFrame,
  computerProgressRunKind,
} from "./progress.ts";
import {
  COMPUTER_SCREEN_STATUS_TICK_MS,
  computerScreenModeV1,
  computerScreenStatusLabelV1,
} from "./live-preview.ts";
import { viewerUrlForControlV1 } from "./viewer.ts";

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

// ---------------------------------------------------------------------------
// Live while working.
//
// The card draws the Bot's own screen region as it changes, in the same
// view-only frame the full-screen viewer uses and on the same minted session
// — no second token, no takeover lease, and no input reaching the desktop.
// Rendering still wakes nothing: with no session minted the card stays on the
// stored capture, which the Bot now files after every Computer action.
// ---------------------------------------------------------------------------
const screen = ref<HTMLElement>();
const onScreen = ref(true);
const documentVisible = ref(
  typeof document === "undefined" || document.visibilityState === "visible",
);
const now = ref(Date.now());
let statusTicker: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
/** When the Bot's last Turn stopped; the grace window is measured from it. */
const turnEndedAt = ref<number | undefined>(undefined);
const turnRunning = computed(() => Boolean(shell?.value.runningRunId));
const screenMode = computed(() =>
  computerScreenModeV1({
    ...(state.value.viewerUrl ? { viewerUrl: state.value.viewerUrl } : {}),
    phase: state.value.phase,
    expanded: state.value.expanded,
    turnRunning: turnRunning.value,
    onScreen: onScreen.value,
    documentVisible: documentVisible.value,
    ...(turnEndedAt.value === undefined
      ? {}
      : { sinceTurnEndedMs: now.value - turnEndedAt.value }),
  }),
);
const streaming = computed(() => screenMode.value === "stream");
// The one client-visible input fence, set the same way the overlay sets it.
// The card never asks for control, so this URL is always the view-only one.
const previewSrc = computed(() =>
  streaming.value && state.value.viewerUrl
    ? viewerUrlForControlV1(state.value.viewerUrl, false)
    : undefined,
);
const screenStatus = computed(() =>
  computerScreenStatusLabelV1({
    mode: screenMode.value,
    ...(screenshot.value ? { capturedAt: screenshot.value.capturedAt } : {}),
    now: now.value,
  }),
);

watch(turnRunning, (running, previous) => {
  if (previous && !running) turnEndedAt.value = Date.now();
  if (running) turnEndedAt.value = undefined;
});
// Holding is what keeps the minted session alive while the card watches it;
// releasing is what stops an idle Bot from paying for a stream nobody reads.
watchEffect(() => {
  state.value.holdLivePreview?.(streaming.value);
});

function readVisibility(): void {
  documentVisible.value =
    typeof document === "undefined" || document.visibilityState === "visible";
}

onMounted(() => {
  document.addEventListener("visibilitychange", readVisibility);
  statusTicker = setInterval(() => {
    now.value = Date.now();
  }, COMPUTER_SCREEN_STATUS_TICK_MS);
  if (typeof IntersectionObserver === "undefined" || !screen.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1);
      if (entry) onScreen.value = entry.isIntersecting;
    },
    { threshold: 0.05 },
  );
  observer.observe(screen.value);
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", readVisibility);
  if (statusTicker !== undefined) clearInterval(statusTicker);
  observer?.disconnect();
  state.value.holdLivePreview?.(false);
});

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
      ref="screen"
      type="button"
      class="computer-screen computer-screen-thumbnail"
      :class="{ 'is-live': streaming }"
      :disabled="busy || unconfigured"
      aria-label="Open computer in full window"
      @click="open"
    >
      <iframe
        v-if="previewSrc && !opening"
        class="computer-screen-preview"
        :src="previewSrc"
        title="Computer, live"
        tabindex="-1"
        aria-hidden="true"
        sandbox="allow-same-origin allow-scripts"
        referrerpolicy="no-referrer"
      />
      <img
        v-else-if="screenshot && !opening"
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
    <p
      v-if="screenStatus"
      class="computer-screen-status"
      :class="{ 'is-live': streaming }"
      aria-live="polite"
    >
      <span class="computer-screen-status-dot" aria-hidden="true" />
      {{ screenStatus }}
    </p>
  </section>
</template>
