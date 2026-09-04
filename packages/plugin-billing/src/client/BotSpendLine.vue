<script setup lang="ts">
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted } from "vue";
import { formatCostV1 } from "./format.js";
import { usageStateKey } from "./state.js";

const providedUsage = inject(usageStateKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedUsage || !providedWeb) {
  throw new Error("usage client services were not provided");
}
const usage = providedUsage;
const web = providedWeb;
const cost = computed(
  () =>
    usage.value.report?.bots.find((row) => row.id === web.value.activeBotId)
      ?.costMicros ?? 0,
);

onMounted(() => {
  if (!usage.value.loaded && !usage.value.busy) void usage.value.load();
});
</script>

<template>
  <p class="bot-spend">
    <span>This month's spend</span>
    <strong>{{ formatCostV1(cost) }}</strong>
  </p>
</template>

<style scoped>
.bot-spend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--frock-radius-control);
  margin: 0;
  padding: var(--frock-radius-control) var(--frock-radius-card);
  border-radius: var(--frock-radius-control);
  color: var(--frock-text-muted);
  background: var(--frock-surface-subtle);
  font-size: var(--frock-text-sm);
}

.bot-spend strong {
  color: var(--frock-text);
}
</style>
