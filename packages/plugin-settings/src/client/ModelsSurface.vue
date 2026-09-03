<script setup lang="ts">
import { UiAnchor } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { inject, onMounted } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("settings client services were not provided");
const web = providedWeb;

const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
const providersLink = settingsLinkV1({ anchor: "user-model-providers" });

onMounted(() => void web.value.loadPluginCatalog());
</script>

<template>
  <div class="models-surface">
    <UiAnchor
      anchor="user-default-model"
      label="Default model"
      :href="defaultModelLink"
      class="models-anchor"
    />
    <div class="models-sections">
      <k-slot name="frockbot.models-sections" />
    </div>
    <UiAnchor
      anchor="user-model-providers"
      label="Model providers"
      :href="providersLink"
      class="models-anchor"
    />
    <p class="models-empty">
      FrockBot picks a model for you. Turn on Custom models in Plugins to choose
      your own.
    </p>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
  </div>
</template>

<style scoped>
.models-surface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.models-anchor {
  min-height: 1px;
}

.models-sections {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.models-empty {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  color: var(--frock-text-muted);
  background: var(--frock-surface-subtle);
  font-size: var(--frock-text-sm);
}

.models-sections:not(:empty) ~ .models-empty {
  display: none;
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
