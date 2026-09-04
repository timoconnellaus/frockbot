<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { computed, inject } from "vue";
import { voiceClientStateKey } from "./state.js";

const provided = inject(voiceClientStateKey);
if (!provided) throw new Error("Voice client state was not provided");
const voice = provided;
const quota = computed(() => {
  const minutes = Math.ceil(voice.value.quotaRemainingSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} left this month`;
});
const activity = computed(() =>
  [
    ...voice.value.transcript.map((entry) => ({
      id: entry.id,
      at: entry.at,
      kind: entry.speaker,
      label: entry.speaker === "user" ? "You" : "Voice",
      text: entry.text,
    })),
    ...voice.value.tools.map((entry) => ({
      id: entry.id,
      at: entry.at,
      kind: "tool" as const,
      label: "Looked up",
      text: entry.label,
    })),
  ].sort((left, right) => left.at.localeCompare(right.at)),
);
</script>

<template>
  <section class="voice-surface">
    <header class="voice-surface__status">
      <span
        class="voice-surface__pulse"
        :class="`voice-surface__pulse--${voice.status}`"
        aria-hidden="true"
      ></span>
      <div>
        <h3>{{ voice.status }}</h3>
        <p>{{ quota }}</p>
      </div>
      <UiButton
        :variant="voice.status === 'offline' ? 'primary' : 'ghost'"
        @click="voice.toggle()"
        >{{ voice.status === "offline" ? "Turn on" : "Turn off" }}</UiButton
      >
    </header>

    <p v-if="voice.message" class="voice-surface__message" role="status">
      {{ voice.message }}
    </p>
    <p v-if="activity.length === 0" class="voice-surface__empty">
      What you say and what Voice answers will appear here.
    </p>
    <ol v-else class="voice-surface__activity" aria-label="This Voice session">
      <li
        v-for="entry in activity"
        :key="entry.id"
        :class="`voice-surface__entry--${entry.kind}`"
        class="voice-surface__entry"
      >
        <span>{{ entry.label }}</span>
        <p>{{ entry.text }}</p>
      </li>
    </ol>
  </section>
</template>
