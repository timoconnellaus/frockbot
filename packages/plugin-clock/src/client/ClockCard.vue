<script setup lang="ts">
import { UiIconButton } from "@frockbot/client-ui";
import { inject, ref } from "vue";
import { clockWebDataKey, type ClockWebData } from "../shared.ts";

const injectedClock = inject(clockWebDataKey);
if (!injectedClock) throw new Error("clock client data was not provided");
const clock = injectedClock;
const refreshing = ref(false);

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await clock.value.refresh();
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <section class="clock-card">
    <div class="clock-heading">
      <strong>Clock</strong>
      <UiIconButton
        icon="refresh"
        label="Refresh time"
        size="sm"
        :class="{ 'clock-refreshing': refreshing }"
        :disabled="refreshing"
        @click="refresh"
      />
    </div>
    <time>{{ clock.lastTime }}</time>
    <small>{{ clock.timezone }}</small>
    <code>/time</code>
  </section>
</template>
