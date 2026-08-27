<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import {
  flySpriteComputerKey,
  type FlySpriteComputerState,
} from "../shared.ts";

const computer = inject(flySpriteComputerKey) ?? useRpc<FlySpriteComputerState>();
const busy = ref(false);
const expanded = ref(false);
const state = computed(() => computer.value);
const hasViewer = computed(() => Boolean(state.value.viewerUrl));
const isHuman = computed(() => state.value.takingControl);
const statusLabel = computed(() => {
  if (isHuman.value) return "Your control";
  if (state.value.phase === "ready") return "Agent control";
  return state.value.phase;
});

async function invoke(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
  } finally {
    busy.value = false;
  }
}

function openExpanded(): void {
  expanded.value = true;
}

function closeExpanded(): void {
  expanded.value = false;
}

function handleScreenKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openExpanded();
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && expanded.value) closeExpanded();
}

onMounted(() => window.addEventListener("keydown", handleWindowKeydown));
onBeforeUnmount(() =>
  window.removeEventListener("keydown", handleWindowKeydown),
);
</script>

<template>
  <section class="sprite-computer" :class="{ 'human-control': isHuman }">
    <header class="sprite-heading">
      <div>
        <strong>Computer</strong>
        <small>{{ state.agentId }} · {{ state.spriteName }}</small>
      </div>
      <span class="sprite-status" :class="`status-${state.phase}`">
        {{ statusLabel }}
      </span>
    </header>

    <div
      class="sprite-screen sprite-screen-thumbnail"
      role="button"
      tabindex="0"
      aria-label="Open computer in full window"
      @click="openExpanded"
      @keydown="handleScreenKeydown"
    >
      <iframe
        v-if="state.viewerUrl && !expanded"
        :src="state.viewerUrl"
        title="Fly Sprite computer preview"
        sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
        referrerpolicy="no-referrer"
      />
      <div v-else class="sprite-placeholder">
        <span class="sprite-mark">✦</span>
        <strong v-if="state.phase === 'missing-token'">Computer not configured</strong>
        <strong v-else-if="state.phase === 'provisioning'">Preparing computer…</strong>
        <strong v-else>Persistent cloud computer</strong>
        <p>{{ state.message }}</p>
        <button
          v-if="state.phase === 'idle'"
          :disabled="busy"
          @click.stop="invoke(state.connect)"
        >
          Start computer
        </button>
        <button
          v-else-if="state.phase === 'error'"
          :disabled="busy"
          @click.stop="invoke(state.retry)"
        >
          Try again
        </button>
      </div>

      <div v-if="hasViewer && !isHuman" class="control-shield">
        <div>
          <strong>{{ state.phase === "taking-control" ? "Pausing agent…" : "Agent has control" }}</strong>
          <p>Take control to enter credentials or handle private steps.</p>
          <button
            :disabled="busy || state.phase === 'taking-control'"
            @click.stop="invoke(state.takeControl)"
          >
            Take control
          </button>
        </div>
      </div>
    </div>

    <footer class="sprite-footer">
      <p>{{ state.message }}</p>
      <button
        v-if="isHuman"
        class="release-button"
        :disabled="busy"
        @click="invoke(state.releaseControl)"
      >
        Release control
      </button>
    </footer>
  </section>

  <Teleport to="body">
    <div
      v-if="expanded"
      class="sprite-computer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Fly Sprite computer"
    >
      <header class="sprite-overlay-toolbar">
        <div class="sprite-overlay-identity">
          <strong>Computer</strong>
          <small>{{ state.agentId }} · {{ state.spriteName }}</small>
        </div>
        <div class="sprite-overlay-actions">
          <span class="sprite-status" :class="`status-${state.phase}`">
            {{ statusLabel }}
          </span>
          <button
            v-if="hasViewer && !isHuman"
            class="sprite-overlay-control"
            :disabled="busy || state.phase === 'taking-control'"
            @click="invoke(state.takeControl)"
          >
            <span aria-hidden="true">◎</span>
            Take control
          </button>
          <button
            v-else-if="isHuman"
            class="sprite-overlay-control release-button"
            :disabled="busy"
            @click="invoke(state.releaseControl)"
          >
            Release control
          </button>
          <button
            class="sprite-overlay-close"
            aria-label="Close full-window computer"
            title="Close (Esc)"
            @click="closeExpanded"
          >
            ×
          </button>
        </div>
      </header>

      <main class="sprite-overlay-stage" :class="{ 'human-control': isHuman }">
        <div class="sprite-screen sprite-screen-expanded">
          <iframe
            v-if="state.viewerUrl"
            :src="state.viewerUrl"
            title="Fly Sprite computer"
            sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
            referrerpolicy="no-referrer"
          />
          <div v-else class="sprite-placeholder">
            <span class="sprite-mark">✦</span>
            <strong v-if="state.phase === 'missing-token'">Computer not configured</strong>
            <strong v-else-if="state.phase === 'provisioning'">Preparing computer…</strong>
            <strong v-else>Persistent cloud computer</strong>
            <p>{{ state.message }}</p>
            <button
              v-if="state.phase === 'idle'"
              :disabled="busy"
              @click="invoke(state.connect)"
            >
              Start computer
            </button>
            <button
              v-else-if="state.phase === 'error'"
              :disabled="busy"
              @click="invoke(state.retry)"
            >
              Try again
            </button>
          </div>

          <div v-if="hasViewer && !isHuman" class="control-shield">
            <div>
              <strong>{{ state.phase === "taking-control" ? "Pausing agent…" : "Agent has control" }}</strong>
              <p>Take control to enter credentials or handle private steps.</p>
              <button
                :disabled="busy || state.phase === 'taking-control'"
                @click="invoke(state.takeControl)"
              >
                Take control
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  </Teleport>
</template>
