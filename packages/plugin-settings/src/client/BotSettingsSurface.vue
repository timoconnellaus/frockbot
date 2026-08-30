<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";

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
const modelOptions = computed(() =>
  (web.value.userSettings?.connections ?? []).flatMap((connection) =>
    connection.state === "ready"
      ? (connection.modelCatalog?.models ?? []).map((model) => ({
          value: JSON.stringify([
            connection.connectionId,
            model.providerModelId,
          ]),
          label: `${model.displayName} — ${connection.displayName}`,
        }))
      : [],
  ),
);

onMounted(async () => {
  await Promise.all([
    web.value.loadBotSettings(),
    web.value.loadUserSettings(),
  ]);
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
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.saveBotProfile({
      name: name.value,
      label: label.value || undefined,
      description: description.value || undefined,
    });
    if (selectedModel.value) {
      const [connectionId, providerModelId] = JSON.parse(
        selectedModel.value,
      ) as [string, string];
      const current = web.value.botSettings?.model;
      if (
        current?.connectionId !== connectionId ||
        current.providerModelId !== providerModelId
      ) {
        await web.value.saveBotModel({ connectionId, providerModelId });
      }
    }
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
    <UiField label="Model">
      <select v-model="selectedModel">
        <option value="">Foundation default</option>
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

.notification-setting strong,
.notification-setting small {
  display: block;
}

.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: 11px;
}

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
