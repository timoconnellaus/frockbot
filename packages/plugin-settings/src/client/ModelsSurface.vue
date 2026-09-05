<script setup lang="ts">
import { UiAnchor, UiButton } from "@frockbot/client-ui";
import { computed, inject, onMounted, ref } from "vue";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
const web = inject(frockBotWebDataKey);
if (!web) throw new Error("Settings client services were not provided");
const modelLabel = computed(() => web.value.modelLabel);
const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
const providersLink = settingsLinkV1({ anchor: "user-model-providers" });
onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadUserSettings();
});
import SettingsFrameView from "./SettingsFrameView.vue";
import ProviderAccounts from "./ProviderAccounts.vue";
const managing = ref(
  typeof location !== "undefined" && location.hash === "#user-model-providers",
);
</script>
<template>
  <div class="models-surface">
    <section class="models-current">
      <h3>Model in use</h3>
      <p>{{ modelLabel }}</p>
    </section>
    <UiAnchor
      anchor="user-default-model"
      label="Default model"
      :href="defaultModelLink"
    />
    <SettingsFrameView home="models" @manage="managing = true" />
    <UiAnchor
      anchor="user-model-providers"
      label="Model providers"
      :href="providersLink"
    />
    <section
      v-if="managing"
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
.models-current {
  padding: 16px;
  background: var(--frock-surface-raised);
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
}
.models-current p {
  margin: 8px 0 0;
  color: var(--frock-text);
  font-weight: 600;
}
h3 {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
}
</style>
