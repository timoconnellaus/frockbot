<script setup lang="ts">
import { useRpc } from "@cordisjs/client";
import { ref } from "vue";
import type { ClockWebData } from "../shared.ts";

const clock = useRpc<ClockWebData>();
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
      <strong>Clock plugin</strong>
      <button :disabled="refreshing" @click="refresh">↻</button>
    </div>
    <time>{{ clock.lastTime }}</time>
    <small>{{ clock.timezone }}</small>
    <code>/time</code>
  </section>
</template>
