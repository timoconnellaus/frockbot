<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField } from "@frockbot/client-ui";
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
const email = ref("");
const saving = ref(false);

onMounted(async () => {
  await web.value.loadUserSettings();
  const settings = web.value.userSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  email.value = settings.profile.email ?? "";
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.saveUserProfile({
      name: name.value,
      email: email.value || undefined,
    });
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

.profile-intro {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.profile-face {
  width: 52px;
  height: 52px;
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
  font-size: var(--frock-text-base);
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
