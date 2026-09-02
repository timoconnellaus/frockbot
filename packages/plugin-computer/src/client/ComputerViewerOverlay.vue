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
import { computerKey, type ComputerState } from "../shared.ts";
import { dialogFocusWrapTarget } from "./dialog-focus.ts";
import {
  createComputerViewerActions,
  viewerUrlForControlV1,
} from "./viewer.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const state = computed(() => computer.value);
const busy = ref(false);
const confirming = ref(false);
const confirmDialog = ref<HTMLElement>();
let restoreFocus: HTMLElement | undefined;
const focusable = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const actions = createComputerViewerActions(
  () => state.value,
  (open) => {
    confirming.value = open;
  },
);
const hasViewer = computed(() => Boolean(state.value.viewerUrl));
const isHuman = computed(() => state.value.takingControl);
const viewerSrc = computed(() =>
  state.value.viewerUrl
    ? viewerUrlForControlV1(state.value.viewerUrl, isHuman.value)
    : undefined,
);
const statusLabel = computed(() => {
  if (isHuman.value) return "Your control";
  if (state.value.phase === "ready") return "View only";
  return state.value.phase.replaceAll("-", " ");
});

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
    // A failed release remains visible in the still-open overlay.
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

onMounted(() => window.addEventListener("keydown", handleWindowKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleWindowKeydown);
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
        <small>{{ state.botId }} · {{ state.providerLabel }}</small>
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
          :src="viewerSrc"
          title="Computer"
          sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
          referrerpolicy="no-referrer"
        />
        <div v-else class="computer-placeholder">
          <strong v-if="state.phase === 'unconfigured'"
            >Computer not configured</strong
          >
          <strong v-else-if="state.phase === 'provisioning'"
            >Preparing computer…</strong
          >
          <strong v-else-if="state.phase === 'disconnected'"
            >Viewer disconnected</strong
          >
          <strong v-else>Persistent Computer</strong>
          <p>{{ state.message }}</p>
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
          The Bot will be fenced from this desktop until you release control.
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
