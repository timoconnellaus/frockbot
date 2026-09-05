<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { ref } from "vue";
import SettingsFrameView from "./SettingsFrameView.vue";
import ProviderAccounts from "./ProviderAccounts.vue";
const managing = ref(
  typeof location !== "undefined" && location.hash === "#user-model-providers",
);
</script>
<template>
  <div class="models-surface">
    <SettingsFrameView home="models" @manage="managing = true" />
    <section
      v-if="managing"
      id="user-model-providers"
      aria-label="Provider accounts"
      class="provider-accounts"
    >
      <div class="provider-heading">
        <h3>Provider accounts</h3>
        <UiButton @click="managing = false">Done</UiButton>
      </div>
      <ProviderAccounts />
    </section>
    <k-slot name="frockbot.models-sections" />
  </div>
</template>
<style scoped>
.models-surface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  min-width: 0;
}
.provider-accounts {
  padding: 16px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}
.provider-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
h3 {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
}
</style>
