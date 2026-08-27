<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { computed, inject, ref } from "vue";
import {
  flySpriteComputerKey,
  type FlySpriteComputerState,
} from "../shared.ts";

const computer = inject(flySpriteComputerKey) ?? useRpc<FlySpriteComputerState>();
const busy = ref(false);
const state = computed(() => computer.value);
const hasViewer = computed(() => Boolean(state.value.viewerUrl));
const isHuman = computed(() => state.value.takingControl);

async function invoke(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="sprite-computer" :class="{ 'human-control': isHuman }">
    <header class="sprite-heading">
      <div>
        <strong>Computer</strong>
        <small>Fly Sprite · {{ state.spriteName }}</small>
      </div>
      <span class="sprite-status" :class="`status-${state.phase}`">
        {{ isHuman ? "Your control" : state.phase === "ready" ? "Agent control" : state.phase }}
      </span>
    </header>

    <div class="sprite-screen">
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
</template>
