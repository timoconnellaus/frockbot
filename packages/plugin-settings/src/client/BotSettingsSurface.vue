<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";
import {
  isModelConnectionEligible,
  resolveBotSettingsModel,
} from "./bot-settings.js";
import CompositionSection from "./CompositionSection.vue";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
const name = ref("");
const label = ref("");
const description = ref("");
const notifications = ref(false);
const saving = ref(false);
const selectedModel = ref("");
const useExactModel = ref(false);
const exactConnectionId = ref("");
const exactProviderModelId = ref("");
const readyConnections = computed(() =>
  (web.value.userSettings?.connections ?? []).filter((connection) =>
    isModelConnectionEligible({
      connection,
      packages: web.value.userSettings?.packages ?? [],
      catalog: web.value.pluginCatalog,
    }),
  ),
);
const modelOptions = computed(() =>
  readyConnections.value.flatMap((connection) =>
    (connection.modelCatalog?.models ?? []).map((model) => ({
      value: JSON.stringify([connection.connectionId, model.providerModelId]),
      label: `${model.displayName} — ${connection.displayName}`,
    })),
  ),
);

onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadBotSettings();
  const settings = web.value.botSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  label.value = settings.profile.label ?? "";
  description.value = settings.profile.description ?? "";
  notifications.value = settings.notifications.enabled;
  selectedModel.value = settings.model
    ? JSON.stringify([
        settings.model.connectionId,
        settings.model.providerModelId,
      ])
    : "";
  exactConnectionId.value =
    settings.model?.connectionId ??
    readyConnections.value[0]?.connectionId ??
    "";
  exactProviderModelId.value = settings.model?.providerModelId ?? "";
  useExactModel.value = Boolean(
    settings.model &&
    !modelOptions.value.some((model) => model.value === selectedModel.value),
  );
});

async function clearModel(): Promise<void> {
  saving.value = true;
  try {
    await web.value.clearBotModel();
    selectedModel.value = "";
    exactProviderModelId.value = "";
    useExactModel.value = false;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not unbind model";
  } finally {
    saving.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const current = web.value.botSettings?.model;
    const selected = resolveBotSettingsModel({
      current,
      useExactModel: useExactModel.value,
      selectedModel: selectedModel.value,
      exactConnectionId: exactConnectionId.value,
      exactProviderModelId: exactProviderModelId.value,
    });
    await web.value.saveBotProfile({
      name: name.value,
      label: label.value || undefined,
      description: description.value || undefined,
    });
    if (selected) await web.value.saveBotModel(selected);
    await web.value.saveBotNotifications({ enabled: notifications.value });
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
    <div class="settings-intro">
      <span class="settings-avatar" aria-hidden="true">⌁</span>
      <div>
        <strong>Shape this Bot</strong>
        <p>Identity and notifications belong to the selected Bot.</p>
      </div>
    </div>
    <UiField label="Name">
      <input v-model="name" maxlength="100" required />
    </UiField>
    <UiField label="Label" hint="optional">
      <input
        v-model="label"
        maxlength="120"
        placeholder="Research, marketing, admin"
      />
    </UiField>
    <UiField label="Description">
      <textarea v-model="description" maxlength="10000" rows="7" />
    </UiField>
    <label class="exact-model-setting">
      <span>
        <strong>Use exact model ID</strong>
        <small>Choose a model not listed in the advisory catalog.</small>
      </span>
      <input v-model="useExactModel" type="checkbox" />
    </label>
    <template v-if="useExactModel">
      <UiField label="Connection">
        <select v-model="exactConnectionId">
          <option disabled value="">Select a Connection</option>
          <option
            v-for="connection in readyConnections"
            :key="connection.connectionId"
            :value="connection.connectionId"
          >
            {{ connection.displayName }}
          </option>
        </select>
      </UiField>
      <UiField label="Exact provider model ID">
        <input
          v-model="exactProviderModelId"
          maxlength="256"
          placeholder="model-name:cloud"
        />
      </UiField>
    </template>
    <UiField v-else label="Model">
      <select v-model="selectedModel">
        <option disabled value="">Select a connected model</option>
        <option
          v-for="model in modelOptions"
          :key="model.value"
          :value="model.value"
        >
          {{ model.label }}
        </option>
      </select>
    </UiField>
    <label class="notification-setting">
      <span>
        <strong>Notifications</strong>
        <small>Get notified when this Bot finishes or needs input.</small>
      </span>
      <input v-model="notifications" type="checkbox" />
    </label>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
    <div class="settings-actions">
      <UiButton
        v-if="web.botSettings?.model"
        type="button"
        :disabled="saving"
        @click="clearModel"
      >
        Unbind model
      </UiButton>
      <UiButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save settings" }}
      </UiButton>
    </div>
    <CompositionSection />
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
}

.settings-intro {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.settings-avatar {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-size: 23px;
}

.settings-intro strong,
.settings-intro p {
  display: block;
  margin: 0;
}

.settings-intro p {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.exact-model-setting,
.notification-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.exact-model-setting strong,
.exact-model-setting small,
.notification-setting strong,
.notification-setting small {
  display: block;
}

.exact-model-setting small,
.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: 11px;
}

.exact-model-setting input,
.notification-setting input {
  width: 19px;
  height: 19px;
  accent-color: var(--frock-action-primary);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: 12px;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
