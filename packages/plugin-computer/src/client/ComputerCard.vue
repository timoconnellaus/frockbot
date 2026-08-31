<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { computerKey, type ComputerState } from "../shared.ts";

const computer = inject(computerKey) ?? useRpc<ComputerState>();
const busy = ref(false);
const expanded = ref(false);
const state = computed(() => computer.value);
const hasViewer = computed(() => Boolean(state.value.viewerUrl));
const isHuman = computed(() => state.value.takingControl);
const screenshots = computed(() => state.value.screenshots ?? []);
const doctor = computed(() => state.value.doctor);
const canRunDoctor = computed(
  () => typeof state.value.runDoctor === "function",
);
const doctorFailures = computed(
  () => doctor.value?.checks.filter((check) => check.status === "fail") ?? [],
);
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
  <section class="computer-card" :class="{ 'human-control': isHuman }">
    <header class="computer-heading">
      <div>
        <strong>Computer</strong>
        <small>{{ state.botId }} · {{ state.providerLabel }}</small>
      </div>
      <span class="computer-status" :class="`status-${state.phase}`">
        {{ statusLabel }}
      </span>
    </header>

    <div
      class="computer-screen computer-screen-thumbnail"
      role="button"
      tabindex="0"
      aria-label="Open computer in full window"
      @click="openExpanded"
      @keydown="handleScreenKeydown"
    >
      <iframe
        v-if="state.viewerUrl && !expanded"
        :src="state.viewerUrl"
        title="Computer preview"
        sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
        referrerpolicy="no-referrer"
      />
      <div v-else class="computer-placeholder">
        <span class="computer-mark">✦</span>
        <strong v-if="state.phase === 'unconfigured'"
          >Computer not configured</strong
        >
        <strong v-else-if="state.phase === 'provisioning'"
          >Preparing computer…</strong
        >
        <strong v-else>Persistent Computer</strong>
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
          <strong>{{
            state.phase === "taking-control"
              ? "Pausing agent…"
              : "Agent has control"
          }}</strong>
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

    <section v-if="screenshots.length > 0" class="computer-screenshots">
      <h3>Screenshots</h3>
      <ul>
        <li v-for="shot in screenshots" :key="shot.contentHash">
          <a :href="shot.url" target="_blank" rel="noreferrer">
            <img :src="shot.url" :alt="`Screenshot taken ${shot.capturedAt}`" />
          </a>
          <small>{{ shot.capturedAt }}</small>
        </li>
      </ul>
    </section>

    <!--
      The self-check, as a human reads it: the failures are what matter, so
      they lead, and the passes are counted rather than listed. A Computer
      nobody has asked says so instead of showing an empty list.
    -->
    <section v-if="canRunDoctor || doctor" class="computer-doctor">
      <header>
        <h3>Self-check</h3>
        <button
          v-if="canRunDoctor"
          :disabled="busy"
          @click="invoke(() => state.runDoctor!())"
        >
          Run self-check
        </button>
      </header>
      <p v-if="!doctor" class="computer-doctor-empty">
        This computer has not been checked yet.
      </p>
      <template v-else>
        <p class="computer-doctor-summary">
          {{ doctor.summary }} · {{ doctor.capturedAt }}
        </p>
        <ul>
          <li
            v-for="check in doctor.checks"
            :key="check.name"
            :class="`doctor-${check.status}`"
          >
            <span class="doctor-mark" aria-hidden="true">{{
              check.status === "pass" ? "✓" : "✗"
            }}</span>
            <strong>{{ check.name }}</strong>
            <small>{{ check.detail }}</small>
          </li>
        </ul>
        <p v-if="doctorFailures.length === 0" class="computer-doctor-empty">
          Everything this computer knows how to check is healthy.
        </p>
      </template>
    </section>

    <footer class="computer-footer">
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
          <button
            v-if="hasViewer && !isHuman"
            class="computer-overlay-control"
            :disabled="busy || state.phase === 'taking-control'"
            @click="invoke(state.takeControl)"
          >
            <span aria-hidden="true">◎</span>
            Take control
          </button>
          <button
            v-else-if="isHuman"
            class="computer-overlay-control release-button"
            :disabled="busy"
            @click="invoke(state.releaseControl)"
          >
            Release control
          </button>
          <button
            class="computer-overlay-close"
            aria-label="Close full-window computer"
            title="Close (Esc)"
            @click="closeExpanded"
          >
            ×
          </button>
        </div>
      </header>

      <main
        class="computer-overlay-stage"
        :class="{ 'human-control': isHuman }"
      >
        <div class="computer-screen computer-screen-expanded">
          <iframe
            v-if="state.viewerUrl"
            :src="state.viewerUrl"
            title="Computer"
            sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"
            referrerpolicy="no-referrer"
          />
          <div v-else class="computer-placeholder">
            <span class="computer-mark">✦</span>
            <strong v-if="state.phase === 'unconfigured'"
              >Computer not configured</strong
            >
            <strong v-else-if="state.phase === 'provisioning'"
              >Preparing computer…</strong
            >
            <strong v-else>Persistent Computer</strong>
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
              <strong>{{
                state.phase === "taking-control"
                  ? "Pausing agent…"
                  : "Agent has control"
              }}</strong>
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
