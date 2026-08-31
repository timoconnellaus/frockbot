<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import {
  decodeModelSelection,
  eligibleModelConnections,
  encodeModelSelection,
  modelSelectOptions,
} from "./bot-settings.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
// Application settings rows are User-scoped, so their links name no Bot.
const profileLink = settingsLinkV1({ anchor: "user-profile" });
const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
const name = ref("");
const email = ref("");
const defaultModel = ref("");
const saving = ref(false);
const readyConnections = computed(() =>
  eligibleModelConnections({
    connections: web.value.userSettings?.connections ?? [],
    packages: web.value.userSettings?.packages ?? [],
    catalog: web.value.pluginCatalog,
  }),
);
const modelOptions = computed(() => modelSelectOptions(readyConnections.value));

onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadUserSettings();
  const settings = web.value.userSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  email.value = settings.profile.email ?? "";
  defaultModel.value = encodeModelSelection(settings.newBotModelTemplate);
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.saveUserProfile({
      name: name.value,
      email: email.value || undefined,
    });
    await web.value.saveDefaultModel(decodeModelSelection(defaultModel.value));
    surfaces?.close();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save settings";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="settings-form" @submit.prevent="save">
    <UiAnchor
      anchor="user-profile"
      label="Your profile"
      :href="profileLink"
      class="settings-row"
    >
      <div class="profile-intro">
        <span class="profile-face" aria-hidden="true" />
        <div>
          <strong>Your profile</strong>
          <p>This identity is shared across your Bots.</p>
        </div>
      </div>
      <UiField label="Name">
        <input v-model="name" maxlength="100" required />
      </UiField>
      <UiField label="Email" hint="optional">
        <input v-model="email" maxlength="320" type="email" />
      </UiField>
    </UiAnchor>
    <UiAnchor
      anchor="user-default-model"
      label="Default model"
      :href="defaultModelLink"
      class="settings-row"
    >
      <UiField
        v-if="modelOptions.length > 0"
        label="Default model"
        hint="used by every Bot"
      >
        <select v-model="defaultModel">
          <option value="">No default model</option>
          <option
            v-for="model in modelOptions"
            :key="model.value"
            :value="model.value"
          >
            {{ model.label }}
          </option>
        </select>
      </UiField>
      <p v-if="modelOptions.length > 0" class="field-hint">
        Used by every Bot unless a Bot overrides it in its advanced settings.
      </p>
      <div v-else class="model-empty">
        <p>Connect a model provider in Plugins first.</p>
        <UiButton type="button" @click="surfaces.open('plugins')">
          Open Plugins
        </UiButton>
      </div>
    </UiAnchor>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
    <div class="settings-actions">
      <UiButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save settings" }}
      </UiButton>
    </div>
    <details class="advanced">
      <summary>
        <span>Advanced</span>
        <span class="advanced__marker" aria-hidden="true"
          ><UiIcon name="arrow-down" size="sm"
        /></span>
      </summary>
      <div class="advanced__body">
        <k-slot name="frockbot.user-settings-sections" />
      </div>
    </details>
  </form>
</template>

<style scoped>
.settings-row {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: var(--frock-control-sm);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.profile-intro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.profile-face {
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  flex: 0 0 auto;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    var(--frock-surface-accent),
    var(--frock-action-primary)
  );
}

.profile-intro strong,
.profile-intro p {
  display: block;
  margin: 0;
}

.profile-intro strong {
  font-size: var(--frock-text-lg);
  font-weight: 600;
}

.profile-intro p {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.field-hint {
  margin: -8px 0 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.model-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.model-empty p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}

.advanced {
  border-top: 1px solid var(--frock-border);
  padding-top: 12px;
}

.advanced summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.advanced summary::-webkit-details-marker {
  display: none;
}

.advanced__marker {
  display: grid;
  place-items: center;
  transition: transform var(--frock-motion-fast);
}

.advanced[open] .advanced__marker {
  transform: rotate(180deg);
}

.advanced__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
}
</style>
