<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton } from "@frockbot/client-ui";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, ref } from "vue";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("Custom models client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;

const providers = computed(() =>
  web.value.pluginCatalog.filter(
    (item) =>
      item.capabilities.some((capability) => capability.kind === "model") &&
      web.value.userSettings?.packages.some(
        (installation) =>
          installation.packageId === item.packageId &&
          installation.version === item.version &&
          installation.state === "installed",
      ),
  ),
);

const apiKeyPackageId = ref<string>();
const apiKeyConnectionTypeId = ref<string>();
const apiKeyLabel = ref("");
const apiKey = ref("");
const apiKeyBaseUrl = ref("");
const labelingConnectionId = ref<string>();
const connectionLabel = ref("");
const rotatingConnectionId = ref<string>();
const rotationKey = ref("");
/**
 * Errors belong to the action that produced them, not to one global slot: a
 * failure here disappears when that same action next succeeds, and closing the
 * form takes it with it.
 */
const connectError = ref<string>();
const rowErrors = ref<Record<string, string>>({});
/** Whether the connect form has a command in flight. */
const connecting = ref(false);
/** Connection ids with a command in flight, so their row can say so. */
const busyConnections = ref<string[]>([]);

/**
 * A Connection's state, in words rather than in the field name.
 *
 * The raw state used to be printed with a CSS `text-transform: capitalize`
 * over it, which turned "ready" into "Ready" and, next to it, "· models fresh"
 * into "· Models Fresh" — Title Case on a phrase that is not a title, and a
 * word ("fresh") that says nothing about what it is fresh about. Both lines
 * are written here, as they should read.
 */
function connectionStateLabel(state: ConnectionView["state"]): string {
  if (state === "ready") return "Ready";
  if (state === "disabled") return "Turned off";
  if (state === "failed") return "Not working";
  if (state === "revoking") return "Disconnecting…";
  if (state === "reconciliation-required") return "Needs attention";
  return "Connecting…";
}

/** Whether this account's model list is current, in the same plain register. */
function modelCatalogLabel(state: string): string {
  if (state === "fresh") return "model list up to date";
  if (state === "stale") return "model list out of date";
  if (state === "refreshing") return "refreshing its model list";
  return `model list ${state}`;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function rowError(connectionId: string): string | undefined {
  return rowErrors.value[connectionId];
}

function isBusy(connectionId: string): boolean {
  return busyConnections.value.includes(connectionId);
}

/** Run a Connection-scoped action, holding its busy and error state. */
async function runForConnection(
  connectionId: string,
  fallback: string,
  action: () => Promise<unknown>,
): Promise<boolean> {
  const { [connectionId]: _cleared, ...rest } = rowErrors.value;
  rowErrors.value = rest;
  busyConnections.value = [...busyConnections.value, connectionId];
  try {
    await action();
    return true;
  } catch (error) {
    rowErrors.value = {
      ...rowErrors.value,
      [connectionId]: failureMessage(error, fallback),
    };
    return false;
  } finally {
    busyConnections.value = busyConnections.value.filter(
      (id) => id !== connectionId,
    );
  }
}

function accountCount(item: PluginCatalogItem): string {
  const count = connections(item).length;
  if (count === 0) return "No account connected";
  return count === 1 ? "1 account" : `${count} accounts`;
}

/** A `failed` Connection is retried in place rather than left to accumulate. */
function retryConnection(
  item: PluginCatalogItem,
  connection: ConnectionView,
): void {
  beginConnect(item);
  apiKeyLabel.value = connection.displayName;
  const baseUrl = connection.settings?.["api-base-url"];
  apiKeyBaseUrl.value = typeof baseUrl === "string" ? baseUrl : "";
  retryingConnectionId.value = connection.connectionId;
}

const retryingConnectionId = ref<string>();

function connections(item: PluginCatalogItem): ConnectionView[] {
  return (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === item.packageId && connection.state !== "revoked",
  );
}

function apiKeyConnectionType(item: PluginCatalogItem) {
  return item.connectionTypes.find(
    (connectionType) => connectionType.authorizationKind === "api-key",
  );
}

function mayConnect(item: PluginCatalogItem): boolean {
  const connectionType = apiKeyConnectionType(item);
  return Boolean(
    connectionType &&
    (connections(item).length === 0 || connectionType.allowMultiple),
  );
}

function beginConnect(item: PluginCatalogItem): void {
  const connectionType = apiKeyConnectionType(item);
  if (!connectionType) return;
  apiKeyPackageId.value = item.packageId;
  apiKeyConnectionTypeId.value = connectionType.id;
  apiKeyLabel.value = item.displayName;
  apiKey.value = "";
  apiKeyBaseUrl.value = "";
  connectError.value = undefined;
  retryingConnectionId.value = undefined;
}

function cancelConnect(): void {
  apiKeyPackageId.value = undefined;
  apiKeyConnectionTypeId.value = undefined;
  apiKey.value = "";
  apiKeyBaseUrl.value = "";
  connectError.value = undefined;
  retryingConnectionId.value = undefined;
}

async function connectApiKey(): Promise<void> {
  if (!apiKeyPackageId.value || !apiKeyConnectionTypeId.value) return;
  if (connecting.value) return;
  connecting.value = true;
  connectError.value = undefined;
  const superseded = retryingConnectionId.value;
  try {
    const apiBaseUrl = apiKeyBaseUrl.value.trim();
    await web.value.createApiKeyConnection({
      packageId: apiKeyPackageId.value,
      connectionTypeId: apiKeyConnectionTypeId.value,
      label: apiKeyLabel.value,
      apiKey: apiKey.value,
      ...(apiBaseUrl ? { settings: { "api-base-url": apiBaseUrl } } : {}),
    });
    // The attempt this one replaces goes away instead of accumulating as a
    // dead row the User has to clear by hand.
    if (superseded) {
      await web.value.disconnectConnection(superseded).catch(() => undefined);
    }
    cancelConnect();
  } catch (error) {
    apiKey.value = "";
    connectError.value = failureMessage(error, "Could not create Connection");
  } finally {
    connecting.value = false;
  }
}

function beginLabeling(connection: ConnectionView): void {
  labelingConnectionId.value = connection.connectionId;
  connectionLabel.value = connection.displayName;
}

async function saveLabel(connectionId: string): Promise<void> {
  const saved = await runForConnection(
    connectionId,
    "Could not rename Connection",
    () => web.value.updateConnectionLabel(connectionId, connectionLabel.value),
  );
  if (!saved) return;
  labelingConnectionId.value = undefined;
  connectionLabel.value = "";
}

async function rotateApiKey(connectionId: string): Promise<void> {
  const key = rotationKey.value;
  rotationKey.value = "";
  const rotated = await runForConnection(
    connectionId,
    "Could not rotate credential",
    () => web.value.rotateApiKeyConnection(connectionId, key),
  );
  if (rotated) rotatingConnectionId.value = undefined;
}

async function refreshModels(connectionId: string): Promise<void> {
  await runForConnection(connectionId, "Could not refresh models", () =>
    web.value.refreshConnectionModels(connectionId),
  );
}

async function setEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  await runForConnection(connectionId, "Could not update Connection", () =>
    web.value.setConnectionEnabled(connectionId, enabled),
  );
}

async function disconnect(connectionId: string): Promise<void> {
  await runForConnection(connectionId, "Could not disconnect", () =>
    web.value.disconnectConnection(connectionId),
  );
}

async function revoke(packageId: string, connectionId: string): Promise<void> {
  await runForConnection(connectionId, "Could not revoke Connection", () =>
    web.value.revokeConnection(packageId, connectionId),
  );
}
</script>

<template>
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
          <small class="provider-count">{{ accountCount(item) }}</small>
        </span>
        <UiButton v-if="mayConnect(item)" @click="beginConnect(item)">
          {{
            connections(item).length === 0 ? "Connect" : "Add another account"
          }}
        </UiButton>
      </div>

      <div
        v-for="connection in connections(item)"
        :key="connection.connectionId"
        class="provider-account"
      >
        <div class="account-identity">
          <span
            class="account-dot"
            :class="{
              'account-dot--ready': connection.state === 'ready',
              'account-dot--attention':
                connection.state === 'failed' ||
                connection.state === 'reconciliation-required',
            }"
            aria-hidden="true"
          />
          <strong>{{ connection.displayName }}</strong>
          <small>{{ connectionStateLabel(connection.state) }}</small>
          <small v-if="connection.modelCatalog">
            · {{ modelCatalogLabel(connection.modelCatalog.state) }}
          </small>
        </div>
        <div class="account-actions">
          <UiButton @click="beginLabeling(connection)">Rename</UiButton>
          <template v-if="connection.authorization?.kind === 'api-key'">
            <UiButton
              v-if="connection.modelCatalog && connection.state === 'ready'"
              @click="refreshModels(connection.connectionId)"
            >
              Refresh models
            </UiButton>
            <UiButton
              v-if="connection.state === 'ready'"
              @click="setEnabled(connection.connectionId, false)"
            >
              Disable
            </UiButton>
            <UiButton
              v-if="connection.state === 'disabled'"
              @click="setEnabled(connection.connectionId, true)"
            >
              Enable
            </UiButton>
            <UiButton
              v-if="
                connection.state === 'ready' || connection.state === 'disabled'
              "
              @click="rotatingConnectionId = connection.connectionId"
            >
              Rotate key
            </UiButton>
            <UiButton
              v-if="connection.state === 'failed'"
              variant="primary"
              @click="retryConnection(item, connection)"
            >
              Try again
            </UiButton>
            <UiButton
              v-if="connection.state !== 'revoking'"
              variant="danger"
              :disabled="isBusy(connection.connectionId)"
              @click="disconnect(connection.connectionId)"
            >
              Disconnect
            </UiButton>
          </template>
          <UiButton
            v-else-if="connection.state !== 'revoking'"
            variant="danger"
            @click="revoke(connection.packageId, connection.connectionId)"
          >
            Revoke
          </UiButton>
        </div>
        <p v-if="isBusy(connection.connectionId)" class="connection-busy">
          Working…
        </p>
        <p
          v-if="rowError(connection.connectionId)"
          class="connection-failure"
          role="alert"
        >
          {{ rowError(connection.connectionId) }}
        </p>
        <p v-if="connection.failure" class="connection-failure" role="alert">
          {{ connection.failure }}
        </p>
        <p
          v-if="connection.modelCatalog?.failure"
          class="connection-failure"
          role="alert"
        >
          {{ connection.modelCatalog.failure }}
        </p>
        <form
          v-if="labelingConnectionId === connection.connectionId"
          class="inline-form"
          @submit.prevent="saveLabel(connection.connectionId)"
        >
          <input
            v-model="connectionLabel"
            maxlength="120"
            aria-label="Connection label"
            required
          />
          <UiButton type="submit">Save label</UiButton>
        </form>
        <form
          v-if="rotatingConnectionId === connection.connectionId"
          class="inline-form"
          @submit.prevent="rotateApiKey(connection.connectionId)"
        >
          <input
            v-model="rotationKey"
            type="password"
            autocomplete="new-password"
            aria-label="New API key"
            required
          />
          <UiButton type="submit">Save new key</UiButton>
        </form>
      </div>

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
        <label v-if="item.packageId === 'provider-ollama-cloud'">
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
        <p v-if="item.packageId === 'provider-ollama-cloud'" class="field-hint">
          Leave empty for Ollama Cloud. Point this at a local Ollama server or
          another Ollama-compatible endpoint.
        </p>
        <p v-if="connectError" class="connection-failure" role="alert">
          {{ connectError }}
        </p>
        <div class="api-key-actions">
          <UiButton :disabled="connecting" @click="cancelConnect">
            Cancel
          </UiButton>
          <UiButton type="submit" variant="primary" :disabled="connecting">
            {{ connecting ? "Connecting…" : "Connect account" }}
          </UiButton>
        </div>
      </form>
    </article>

    <div v-if="providers.length === 0" class="provider-empty">
      <p>No model provider is enabled.</p>
      <UiButton @click="surfaces.open('plugins')">Open Plugins</UiButton>
    </div>
  </div>
</template>

<style scoped>
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

.connection-busy {
  margin: 4px 0 0;
  color: var(--frock-text-muted, inherit);
  font-size: var(--frock-text-sm);
}

.provider-copy strong,
.provider-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.provider-copy strong,
.account-identity strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.provider-copy small,
.account-identity small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.provider-account {
  display: grid;
  gap: 8px;
  padding: 12px 8px;
  border-top: 1px solid var(--frock-border);
}

.account-identity {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.account-dot {
  width: 8px;
  height: 8px;
  align-self: center;
  border-radius: 999px;
  background: var(--frock-text-subtle);
}

.account-dot--ready {
  background: var(--frock-success);
}

.account-dot--attention {
  background: var(--frock-danger-text);
}

/*
 * One edge for every row of buttons.
 *
 * Right-aligned and wrapping, a card with five actions put four on one line
 * and pushed the fifth out on its own against the far edge, lined up with
 * nothing; the card next to it, with two, sat in a third position again.
 * Aligning them to the card's left edge — the same edge the account's name
 * starts at — gives every row the same start whatever it holds.
 */
.account-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.api-key-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.account-actions :deep(.ui-button),
.inline-form :deep(.ui-button) {
  min-height: 28px;
  padding: 0 10px;
  font-size: var(--frock-text-sm);
}

.inline-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  animation: frock-rise-in var(--frock-motion-panel) both;
}

.inline-form input,
.api-key-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.connection-failure {
  margin: 0;
  color: var(--frock-danger-text);
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

.api-key-form span,
.field-hint,
.provider-empty p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.provider-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}
</style>
