<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { inject, onMounted, ref } from "vue";

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

onMounted(async () => {
  await web.value.loadBotSettings();
  const settings = web.value.botSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  label.value = settings.profile.label ?? "";
  description.value = settings.profile.description ?? "";
  notifications.value = settings.notifications.enabled;
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.saveBotProfile({
      name: name.value,
      label: label.value || undefined,
      description: description.value || undefined,
    });
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
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-normal);
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

.notification-setting strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.notification-setting input {
  width: 19px;
  height: 19px;
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
