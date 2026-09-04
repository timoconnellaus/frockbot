<script setup lang="ts">
import { UiIcon } from "@frockbot/client-ui";
import { computed, inject } from "vue";
import { voiceClientStateKey } from "./state.js";

const provided = inject(voiceClientStateKey);
if (!provided) throw new Error("Voice client state was not provided");
const voice = provided;
const active = computed(() => voice.value.status !== "offline");
const label = computed(() =>
  active.value ? "Turn Voice off" : "Turn Voice on",
);
</script>

<template>
  <button
    type="button"
    class="voice-toggle"
    :class="`voice-toggle--${voice.status}`"
    :aria-label="label"
    :aria-pressed="active"
    :title="`${label} — ${voice.status}`"
    @click="voice.toggle()"
    @contextmenu.prevent="voice.open()"
  >
    <UiIcon name="mic" />
    <span class="voice-toggle__state" aria-hidden="true"></span>
  </button>
</template>
