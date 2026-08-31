<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";
import {
  describeModelAssignment,
  eligibleModelConnections,
  encodeModelSelection,
  modelSelectOptions,
  resolveBotSettingsModel,
} from "./bot-settings.js";

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
const modelMode = ref<"default" | "custom">("default");
const selectedModel = ref("");
const useExactModel = ref(false);
const exactConnectionId = ref("");
const exactProviderModelId = ref("");
const readyConnections = computed(() =>
  eligibleModelConnections({
    connections: web.value.userSettings?.connections ?? [],
    packages: web.value.userSettings?.packages ?? [],
    catalog: web.value.pluginCatalog,
  }),
);
const modelOptions = computed(() => modelSelectOptions(readyConnections.value));
const defaultModelName = computed(
  () =>
    describeModelAssignment(
      web.value.userSettings?.newBotModelTemplate,
      web.value.userSettings?.connections ?? [],
    ) ?? "none set",
);
const overriding = computed(() => Boolean(web.value.botSettings?.model));

onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadBotSettings();
  const settings = web.value.botSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  label.value = settings.profile.label ?? "";
  description.value = settings.profile.description ?? "";
  notifications.value = settings.notifications.enabled;
  modelMode.value = settings.model ? "custom" : "default";
  selectedModel.value = encodeModelSelection(settings.model);
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

async function saveModel(): Promise<void> {
  if (modelMode.value === "default") {
    // Following the default means holding no Bot binding at all.
    if (web.value.botSettings?.model) await web.value.clearBotModel();
    return;
  }
  const selected = resolveBotSettingsModel({
    current: web.value.botSettings?.model,
    useExactModel: useExactModel.value,
    selectedModel: selectedModel.value,
    exactConnectionId: exactConnectionId.value,
    exactProviderModelId: exactProviderModelId.value,
  });
  if (selected) await web.value.saveBotModel(selected);
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.saveBotProfile({
      name: name.value,
      label: label.value || undefined,
      description: description.value || undefined,
    });
    await saveModel();
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
      <span class="settings-avatar" aria-hidden="true"
        ><UiIcon name="sparkle" size="lg"
      /></span>
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
    <label class="notification-setting">
      <span>
        <strong>Notifications</strong>
        <small>Get notified when this Bot finishes or needs input.</small>
      </span>
      <input v-model="notifications" type="checkbox" />
    </label>
    <p v-if="overriding" class="model-note">Overrides default model</p>
    <details class="advanced">
      <summary>
        <span>Advanced</span>
        <span class="advanced__marker" aria-hidden="true"
          ><UiIcon name="arrow-down" size="sm"
        /></span>
      </summary>
      <div class="advanced__body">
        <fieldset class="model-mode">
          <legend>Model</legend>
          <label>
            <input v-model="modelMode" type="radio" value="default" />
            <span>Use default model ({{ defaultModelName }})</span>
          </label>
          <label>
            <input v-model="modelMode" type="radio" value="custom" />
            <span>Custom model</span>
          </label>
        </fieldset>
        <template v-if="modelMode === 'custom'">
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
        </template>
      </div>
    </details>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
    <div class="settings-actions">
      <UiButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save settings" }}
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.settings-intro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.settings-avatar {
  display: grid;
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
}

.settings-intro strong,
.settings-intro p {
  display: block;
  margin: 0;
}

.settings-intro strong {
  font-size: var(--frock-text-lg);
  font-weight: 600;
}

.settings-intro p {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.exact-model-setting,
.notification-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
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

.notification-setting strong,
.exact-model-setting strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.exact-model-setting small,
.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.exact-model-setting input[type="checkbox"],
.notification-setting input[type="checkbox"] {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
  accent-color: var(--frock-action-primary);
}

.model-note {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
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
  gap: 12px;
  padding-top: 12px;
}

.model-mode {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  border: 0;
  padding: 0;
}

.model-mode legend {
  float: left;
  width: 100%;
  margin-bottom: 4px;
  padding: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.model-mode label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  cursor: pointer;
}

.model-mode input {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  accent-color: var(--frock-action-primary);
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
</style>
