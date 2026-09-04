<script setup lang="ts">
import { BILLING_TURN_REFUSAL_MESSAGE_V1 } from "@frockbot/plugin-shell/run-protocol";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted } from "vue";
import { formatCostV1 } from "./format.js";
import { usageStateKey } from "./state.js";

const LOW_BALANCE_MICROS = 2_000_000;
const provided = inject(usageStateKey);
if (!provided) throw new Error("billing client service was not provided");
const billing = provided;
const href = settingsLinkV1({ anchor: "billing" });
const visible = computed(
  () =>
    billing.value.billing !== undefined &&
    billing.value.billing.availableMicros <= LOW_BALANCE_MICROS,
);
const message = computed(() => {
  const available = billing.value.billing?.availableMicros ?? 0;
  return available <= 0
    ? BILLING_TURN_REFUSAL_MESSAGE_V1
    : `${formatCostV1(available)} of usage credit remains.`;
});

onMounted(() => {
  if (!billing.value.loaded) void billing.value.load();
});
</script>

<template>
  <p v-if="visible" class="balance-notice" role="status">
    <span>{{ message }}</span>
    <a :href="href">Billing</a>
  </p>
</template>

<style scoped>
.balance-notice {
  position: absolute;
  bottom: calc(100% + var(--frock-radius-control));
  left: 0;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--frock-radius-control);
  margin: 0;
  padding: var(--frock-radius-control);
  border: 1px solid var(--frock-warning-border);
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: var(--frock-warning-surface);
  box-shadow: var(--frock-shadow-control);
  font-size: var(--frock-text-sm);
}

.balance-notice a {
  flex: 0 0 auto;
  color: var(--frock-action-primary);
  font-weight: 700;
}
</style>
