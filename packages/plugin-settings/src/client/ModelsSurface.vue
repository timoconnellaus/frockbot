<script setup lang="ts">
/**
 * Models: where a User configures model provider Packages and picks a model.
 *
 * Enablement is not here — Plugins turns a provider on and off, and a disabled
 * provider disappears from this surface with its accounts and its catalogs
 * intact.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiField } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import {
  decodeModelSelection,
  eligibleModelConnections,
  encodeModelSelection,
  modelSelectOptions,
} from "./bot-settings.js";
import { configurablePackages } from "./package-surfaces.js";
import PackageAccounts from "./PackageAccounts.vue";
import PackageSettingsForm from "./PackageSettingsForm.vue";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
// Model configuration is User-scoped, so these links name no Bot.
const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
const providersLink = settingsLinkV1({ anchor: "user-model-providers" });

const defaultModel = ref("");
const savingModel = ref(false);

/**
 * The endpoint root of an Ollama Cloud Connection, declared by that Connection
 * Type as `api-base-url`. It is the only Connection Type setting the shared
 * API-key form has a field for.
 */
const OLLAMA_PACKAGE_ID = "provider-ollama-cloud";
const apiKeyPackageId = ref<string>();
const apiKeyConnectionTypeId = ref<string>();
const apiKeyLabel = ref("");
const apiKey = ref("");
const apiKeyBaseUrl = ref("");

const providers = computed(() =>
  configurablePackages({
    catalog: web.value.pluginCatalog,
    packages: web.value.userSettings?.packages ?? [],
    home: "models",
  }),
);
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
  defaultModel.value = encodeModelSelection(
    web.value.userSettings?.newBotModelTemplate,
  );
});

async function saveDefaultModel(): Promise<void> {
  savingModel.value = true;
  try {
    await web.value.saveDefaultModel(decodeModelSelection(defaultModel.value));
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save the model";
  } finally {
    savingModel.value = false;
  }
}

function connectionCount(packageId: string): number {
  return (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === packageId && connection.state !== "revoked",
  ).length;
}

function beginConnect(item: PluginCatalogItem): void {
  const connectionType = item.connectionTypes[0];
  if (!connectionType) return;
  apiKeyPackageId.value = item.packageId;
  apiKeyConnectionTypeId.value = connectionType.id;
  apiKeyLabel.value = item.displayName;
  apiKey.value = "";
  apiKeyBaseUrl.value = "";
}

function cancelConnect(): void {
  apiKey.value = "";
  apiKeyBaseUrl.value = "";
  apiKeyPackageId.value = undefined;
  apiKeyConnectionTypeId.value = undefined;
}

async function connectApiKey(): Promise<void> {
  if (!apiKeyPackageId.value || !apiKeyConnectionTypeId.value) return;
  try {
    // An empty endpoint field means the Package default, so the command
    // carries no settings at all rather than an empty bag.
    const apiBaseUrl = apiKeyBaseUrl.value.trim();
    await web.value.createApiKeyConnection({
      packageId: apiKeyPackageId.value,
      connectionTypeId: apiKeyConnectionTypeId.value,
      label: apiKeyLabel.value,
      apiKey: apiKey.value,
      ...(apiBaseUrl ? { settings: { "api-base-url": apiBaseUrl } } : {}),
    });
    cancelConnect();
  } catch (error) {
    apiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not create Connection";
  }
}
</script>

<template>
  <div class="models-surface">
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
        Used by every Bot unless a Bot overrides it in its own settings.
      </p>
      <div v-else class="model-empty">
        <p>
          Connect a model provider below, then choose the model your Bots use.
        </p>
      </div>
      <div v-if="modelOptions.length > 0" class="settings-actions">
        <UiButton
          type="button"
          variant="primary"
          :disabled="savingModel"
          @click="saveDefaultModel"
        >
          {{ savingModel ? "Saving…" : "Save model" }}
        </UiButton>
      </div>
    </UiAnchor>

    <UiAnchor
      anchor="user-model-providers"
      label="Model providers"
      :href="providersLink"
      class="settings-row"
    >
      <p class="field-hint">
        Accounts and endpoints for the model providers you have enabled.
      </p>
      <div class="provider-grid">
        <article
          v-for="item in providers"
          :key="item.packageId"
          class="provider-card"
        >
          <div class="provider-summary">
            <span class="provider-logo" aria-hidden="true">
              {{ item.displayName.slice(0, 1) }}
            </span>
            <span class="provider-copy">
              <strong>{{ item.displayName }}</strong>
              <small>
                {{
                  connectionCount(item.packageId) === 0
                    ? "No account connected"
                    : `${connectionCount(item.packageId)} account(s)`
                }}
              </small>
            </span>
            <UiButton
              v-if="
                connectionCount(item.packageId) === 0 ||
                item.connectionTypes[0]?.allowMultiple
              "
              @click="beginConnect(item)"
            >
              {{
                connectionCount(item.packageId) === 0
                  ? "Connect"
                  : "Add another account"
              }}
            </UiButton>
          </div>

          <PackageAccounts :item="item" />

          <form
            v-if="apiKeyPackageId === item.packageId"
            class="api-key-form"
            @submit.prevent="connectApiKey"
          >
            <label>
              <span>Connection label</span>
              <input v-model="apiKeyLabel" maxlength="120" required />
            </label>
            <label>
              <span>API key</span>
              <input
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                required
              />
            </label>
            <label v-if="item.packageId === OLLAMA_PACKAGE_ID">
              <span>API base URL</span>
              <input
                v-model="apiKeyBaseUrl"
                type="url"
                inputmode="url"
                autocomplete="off"
                maxlength="2048"
                placeholder="https://ollama.com"
              />
            </label>
            <p v-if="item.packageId === OLLAMA_PACKAGE_ID" class="field-hint">
              Leave empty for Ollama Cloud. Point this at a local Ollama server
              (http://127.0.0.1:11434) or any Ollama-compatible endpoint.
            </p>
            <div class="api-key-actions">
              <UiButton @click="cancelConnect">Cancel</UiButton>
              <UiButton type="submit" variant="primary">
                Connect account
              </UiButton>
            </div>
          </form>

          <PackageSettingsForm :item="item" />
        </article>
      </div>
      <div v-if="providers.length === 0" class="model-empty">
        <p>No model provider is enabled.</p>
        <UiButton type="button" @click="surfaces.open('plugins')">
          Open Plugins
        </UiButton>
      </div>
    </UiAnchor>

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

.settings-row {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: var(--frock-control-sm);
}

.field-hint {
  margin: 0;
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

.provider-grid {
  display: grid;
  gap: 12px;
}

.provider-card {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
}

.provider-summary {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px;
}

.provider-logo {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 12px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-weight: 800;
}

.provider-copy {
  min-width: 0;
}

.provider-copy strong,
.provider-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.provider-copy strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.provider-copy small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.api-key-form {
  display: grid;
  gap: 12px;
  margin: 0 8px;
  padding: 12px 0 8px;
  border-top: 1px solid var(--frock-border);
  animation: frock-rise-in var(--frock-motion-enter) both;
}

.api-key-form label {
  display: grid;
  gap: 6px;
}

.api-key-form span {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.api-key-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.api-key-actions,
.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
