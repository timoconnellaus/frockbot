<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { UiButton, UiIconButton } from "@frockbot/client-ui";
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computerKey, type ComputerState } from "../shared.ts";
import { dialogFocusWrapTarget } from "./dialog-focus.ts";
import { computerProgressFrame, computerProgressRunKind } from "./progress.ts";
import {
  createComputerViewerActions,
  decodeComputerViewerFrameMessageV1,
  type ComputerViewerFrameStateV1,
  viewerUrlForControlV1,
} from "./viewer.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const state = computed(() => computer.value);
const busy = ref(false);
// The Bot as its User named it. A raw slug and an infrastructure vendor are
// architecture, not identity, and the viewer header is the User's screen.
const shell = inject(frockBotWebDataKey, undefined);
const botName = computed(
  () => shell?.value.botSettings?.profile.name ?? "Computer",
);
const confirming = ref(false);
const confirmDialog = ref<HTMLElement>();
const viewerFrame = ref<HTMLIFrameElement>();
const frameState = ref<"loading" | ComputerViewerFrameStateV1>("loading");
const frameMessage = ref("Loading…");
const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let localProgressStartedAt = Date.now();
let elapsedWasActive = false;
let restoreFocus: HTMLElement | undefined;
const focusable = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const actions = createComputerViewerActions(
  () => state.value,
  (open) => {
    confirming.value = open;
  },
);
const hasViewer = computed(
  () =>
    Boolean(state.value.viewerUrl) &&
    state.value.phase !== "provisioning" &&
    state.value.phase !== "updating",
);
const isHuman = computed(() => state.value.takingControl);
const viewerSrc = computed(() =>
  hasViewer.value && state.value.viewerUrl
    ? viewerUrlForControlV1(state.value.viewerUrl, isHuman.value)
    : undefined,
);
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
    ? "This usually takes 2-3 minutes"
    : undefined,
);
const progressSteps = computed(
  () =>
    state.value.progress?.steps ?? [
      {
        version: 1 as const,
        id: state.value.phase,
        label: state.value.message,
        status: "active" as const,
      },
    ],
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
    elapsedMs: elapsedSeconds.value * 1_000,
  }),
);
const progressValueNow = computed(() => {
  const fraction = progressFrame.value.fraction;
  return fraction === undefined ? undefined : Math.round(fraction * 100);
});
const progressFillStyle = computed(() => {
  const fraction = progressFrame.value.fraction;
  return fraction === undefined ? undefined : { width: `${fraction * 100}%` };
});
const progressAriaLabel = computed(
  () => `${openingHeading.value}: ${progressPhaseLabel.value}`,
);
const progressPosition = computed(() => {
  const progress = state.value.progress;
  if (!progress) return undefined;
  const provisioning = progress.provisioning;
  return provisioning
    ? provisioning.index === 0
      ? "Starting setup"
      : `Phase ${provisioning.index} of ${provisioning.total}`
    : `Step ${progress.index} of ${progress.total}`;
});
const statusLabel = computed(() => {
  if (hasViewer.value && frameState.value !== "connected") {
    return frameMessage.value;
  }
  if (isHuman.value) return "Your control";
  if (state.value.phase === "ready") return "View only";
  if (state.value.phase === "updating") return state.value.message;
  return state.value.phase.replaceAll("-", " ");
});

function updateElapsed(): void {
  const durableStart = state.value.progress?.startedAt;
  const parsed = durableStart ? Date.parse(durableStart) : Number.NaN;
  const startedAt = Number.isFinite(parsed) ? parsed : localProgressStartedAt;
  elapsedSeconds.value = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1_000),
  );
}

function syncElapsed(): void {
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  if (!state.value.expanded || !opening.value) {
    elapsedSeconds.value = 0;
    return;
  }
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1_000);
}

function handleFrameLoad(): void {
  if (frameState.value === "loading") {
    frameState.value = "connecting";
    frameMessage.value = "Connecting to desktop…";
  }
}

function handleViewerMessage(event: MessageEvent): void {
  if (event.source !== viewerFrame.value?.contentWindow) return;
  const source = state.value.viewerUrl;
  if (!source || event.origin !== new URL(source).origin) return;
  const message = decodeComputerViewerFrameMessageV1(event.data);
  if (!message) return;
  frameState.value = message.state;
  frameMessage.value = message.message;
}

async function invoke(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
  } catch {
    // The shared state already projects the command's visible failure.
  } finally {
    busy.value = false;
  }
}

async function closeViewer(escape = false): Promise<void> {
  try {
    await (escape ? actions.escape() : actions.closeViewer());
  } catch {
    // The overlay collapses either way: a release the Computer refused is
    // recorded durably and shown on the card, and is never a reason to trap
    // the User in a full-screen viewer.
  }
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !state.value.expanded) return;
  event.preventDefault();
  void closeViewer(true);
}

function handleConfirmKeydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !confirmDialog.value) return;
  const controls = [
    ...confirmDialog.value.querySelectorAll<HTMLElement>(focusable),
  ];
  const target = dialogFocusWrapTarget(
    controls,
    document.activeElement as HTMLElement | null,
    event.shiftKey,
  );
  if (!target) return;
  event.preventDefault();
  target.focus();
}

watch(
  confirming,
  async (open, previous) => {
    if (open && !previous) {
      restoreFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      await nextTick();
      confirmDialog.value
        ?.querySelector<HTMLElement>("[autofocus], " + focusable)
        ?.focus();
    } else if (!open && previous) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  },
  { flush: "post" },
);
watch(
  () => state.value.expanded,
  (expanded) => {
    if (!expanded) confirming.value = false;
  },
);
watch(
  () => state.value.viewerUrl,
  () => {
    frameState.value = "loading";
    frameMessage.value = "Loading viewer frame…";
  },
);
watch(
  [() => state.value.expanded, opening, () => state.value.progress?.startedAt],
  ([expanded, active]) => {
    if (expanded && active && !elapsedWasActive) {
      localProgressStartedAt = Date.now();
    }
    elapsedWasActive = Boolean(expanded && active);
    syncElapsed();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("keydown", handleWindowKeydown);
  window.addEventListener("message", handleViewerMessage);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleWindowKeydown);
  window.removeEventListener("message", handleViewerMessage);
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  restoreFocus?.focus();
});
</script>

<template>
  <div
    v-if="state.expanded"
    class="computer-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Computer"
  >
    <header class="computer-overlay-toolbar">
      <div class="computer-overlay-identity">
        <strong>Computer</strong>
        <small>{{ botName }}</small>
      </div>
      <div class="computer-overlay-actions">
        <span class="computer-status" :class="`status-${state.phase}`">
          {{ statusLabel }}
        </span>
        <UiButton
          v-if="isHuman"
          variant="primary"
          :disabled="busy"
          @click="invoke(state.releaseControl)"
        >
          Release control
        </UiButton>
        <UiButton
          v-else-if="state.phase === 'disconnected'"
          :disabled="busy"
          @click="invoke(state.connect)"
        >
          Reconnect
        </UiButton>
        <UiButton
          v-else-if="hasViewer"
          :disabled="busy || state.phase === 'taking-control'"
          @click="actions.requestTakeControl"
        >
          {{
            state.phase === "taking-control" ? "Pausing Bot…" : "Take control"
          }}
        </UiButton>
        <UiIconButton
          icon="close"
          label="Close full-window computer (Esc)"
          variant="outlined"
          shape="square"
          @click="closeViewer()"
        />
      </div>
    </header>

    <main class="computer-overlay-stage" :class="{ 'human-control': isHuman }">
      <div class="computer-screen computer-screen-expanded">
        <iframe
          v-if="viewerSrc"
          ref="viewerFrame"
          :src="viewerSrc"
          title="Computer"
          sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
          referrerpolicy="no-referrer"
          @load="handleFrameLoad"
        />
        <div v-else class="computer-placeholder">
          <strong v-if="state.phase === 'unconfigured'">No computer</strong>
          <template v-else-if="opening">
            <strong>{{ openingHeading }}</strong>
            <p v-if="setupExpectation" class="computer-setup-expectation">
              {{ setupExpectation }}
            </p>
            <p
              class="computer-progress-phase"
              aria-live="polite"
              aria-atomic="true"
            >
              {{ progressPhaseLabel }}
            </p>
            <div
              class="computer-progress-track"
              :class="{ 'is-determinate': progressValueNow !== undefined }"
              role="progressbar"
              :aria-label="progressAriaLabel"
              :aria-valuemin="progressValueNow === undefined ? undefined : 0"
              :aria-valuemax="progressValueNow === undefined ? undefined : 100"
              :aria-valuenow="progressValueNow"
            >
              <span :style="progressFillStyle" />
            </div>
            <div class="computer-progress-meta">
              <span v-if="progressPosition">{{ progressPosition }}</span>
              <span>{{ elapsedSeconds }}s elapsed</span>
            </div>
            <ol class="computer-progress-steps">
              <li
                v-for="step in progressSteps"
                :key="step.id"
                :class="`step-${step.status}`"
              >
                <span aria-hidden="true" />
                {{ step.label }}
              </li>
            </ol>
          </template>
          <strong v-else-if="state.phase === 'disconnected'"
            >Viewer disconnected</strong
          >
          <strong v-else>Computer</strong>
          <p v-if="!opening">{{ state.message }}</p>
          <UiButton
            v-if="state.phase === 'idle' || state.phase === 'disconnected'"
            :disabled="busy"
            @click="invoke(state.connect)"
          >
            {{
              state.phase === "disconnected" ? "Reconnect" : "Start computer"
            }}
          </UiButton>
          <UiButton
            v-else-if="state.phase === 'error'"
            :disabled="busy"
            @click="invoke(state.retry)"
          >
            Try again
          </UiButton>
        </div>
      </div>
    </main>

    <div
      v-if="confirming"
      class="computer-confirm-backdrop"
      @click.self="actions.cancelTakeControl"
    >
      <section
        ref="confirmDialog"
        class="computer-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="computer-confirm-title"
        aria-describedby="computer-confirm-detail"
        @keydown="handleConfirmKeydown"
      >
        <h2 id="computer-confirm-title">Take control of this Computer?</h2>
        <p id="computer-confirm-detail">
          The Bot won't touch this desktop until you release control.
        </p>
        <div class="computer-confirm-actions">
          <UiButton @click="actions.cancelTakeControl">Cancel</UiButton>
          <UiButton
            autofocus
            variant="primary"
            @click="invoke(actions.confirmTakeControl)"
          >
            Take control
          </UiButton>
        </div>
      </section>
    </div>
  </div>
</template>
