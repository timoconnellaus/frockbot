<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { authSessionClientKey } from "@frockbot/plugin-auth/shared";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { inject, onMounted, ref } from "vue";
import PackageSettingsSection from "./PackageSettingsSection.vue";
import { resolveUserDisplayName } from "./user-display-name.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedAuth = inject(authSessionClientKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedAuth || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const auth = providedAuth;
const web = providedWeb;
// Application settings rows are User-scoped, so their links name no Bot.
const profileLink = settingsLinkV1({ anchor: "user-profile" });
const packageSettingsLink = settingsLinkV1({ anchor: "user-package-settings" });
const name = ref("");
const email = ref("");
const saving = ref(false);

onMounted(async () => {
  await web.value.loadPluginCatalog();
  await web.value.loadUserSettings();
  const settings = web.value.userSettings;
  if (!settings) return;
  const sessionUser =
    auth.projection.value.status === "authenticated"
      ? auth.projection.value.user
      : undefined;
  name.value = resolveUserDisplayName({
    savedName: settings.profile.name,
    sessionName: sessionUser?.name,
    sessionEmail: sessionUser?.email,
  });
  email.value = settings.profile.email ?? sessionUser?.email ?? "";
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
      anchor="user-package-settings"
      label="Package settings"
      :href="packageSettingsLink"
      class="settings-row"
    >
      <p class="field-hint">
        Settings of the Packages you have enabled. Model providers are
        configured in Models and accounts in Connectors.
      </p>
      <PackageSettingsSection />
      <UiButton type="button" @click="surfaces.open('plugins')">
        Open Plugins
      </UiButton>
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
