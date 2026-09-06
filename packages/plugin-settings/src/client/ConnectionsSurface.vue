<script setup lang="ts">
/**
 * Connectors: the surface for accounts and services a User authorizes for all
 * of their Bots — Gmail, Calendar, or a remote server.
 *
 * It holds Connection authorization and state only. Whether the Package
 * providing a connector is enabled at all is Plugins' question.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
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
// Connections are User-scoped, so the row's link names no Bot.
const connectionsLink = settingsLinkV1({ anchor: "user-connections" });

/**
 * What the browser came back from an external grant with. Read at boot from the
 * return URL; without this the User lands back in the app with no confirmation
 * and a cancelled grant is silently discarded.
 */
const connectionReturn = computed(() => web.value.connectionReturn);

const connectionReturnMessage = computed(() => {
  const result = connectionReturn.value;
  if (!result) return "";
  const name = connectorDisplayName(result.packageId);
  if (result.status === "ready") return `${name} is connected.`;
  if (result.status === "pending") {
    return `${name} is finishing connecting. This page will show it when it is ready.`;
  }
  return result.reason
    ? `${name} did not connect: ${result.reason}`
    : `${name} did not connect.`;
});

/** The Package's display name when the catalog knows it, its id otherwise. */
function connectorDisplayName(packageId: string): string {
  const item = web.value.pluginCatalog.find(
    (item) => item.packageId === packageId,
  );
  return !item || item.connectionTypes.some((type) => type.catalogPath)
    ? "Your account"
    : item.displayName;
}

function dismissConnectionReturn(): void {
  web.value.connectionReturn = undefined;
}

/**
 * The line under a connector's name.
 *
 * It used to be the Connection Type's own name, which for most Packages is the
 * Package's name again in the singular, and says nothing a User did not
 * already read on the line above. What a User wants from a card they are not
 * opening is whether it is on, so that is what it says.
 */
function connectorStatus(item: PluginCatalogItem): string {
  if (item.connectionTypes[0]?.authorizationKind === "none") {
    return credentiallessConnection(item)?.state === "ready"
      ? "On for every Bot you own"
      : "Off";
  }
  const count = connectionCount(item);
  if (count === 0) return "No account connected";
  return count === 1 ? "1 account connected" : `${count} accounts connected`;
}

const search = ref("");
const connectors = computed(() => {
  const rows = configurablePackages({
    catalog: web.value.pluginCatalog,
    packages: web.value.userSettings?.packages ?? [],
    home: "connections",
  }).flatMap((item): PluginCatalogItem[] => {
    const dynamic = item.connectionTypes.filter((type) => type.catalogPath);
    if (dynamic.length)
      return dynamic.flatMap((type) => {
        const entries = [
          ...(web.value.connectorCatalog?.[`${item.packageId}/${type.id}`] ??
            []),
        ];
        for (const connection of web.value.userSettings?.connections ?? []) {
          const id = connection.safeMetadata.connectorId;
          if (
            connection.packageId !== item.packageId ||
            connection.state === "revoked" ||
            typeof id !== "string" ||
            entries.some((entry) => entry.id === id)
          )
            continue;
          entries.push({
            id,
            name: String(
              connection.safeMetadata.connectorName ?? connection.displayName,
            ),
            description: "Your connected account",
          });
        }
        return entries.map((entry) => ({
          ...item,
          displayName: entry.name,
          connectorId: entry.id,
          connectorDescription: entry.description,
          connectorIcon: entry.icon,
          connectionTypes: [type],
        }));
      });
    return [item];
  });
  const query = search.value.trim().toLowerCase();
  return rows
    .filter((item) =>
      `${item.displayName} ${item.connectorDescription ?? ""}`
        .toLowerCase()
        .includes(query),
    )
    .sort(
      (a, b) =>
        Number(connectionCount(b) > 0) - Number(connectionCount(a) > 0) ||
        a.displayName.localeCompare(b.displayName),
    );
});

/**
 * The connect cards. Drawn from the Connection projection — which carries no
 * URL — so a card can be shown by anything that can read Connections, while
 * the redirect is authored only when the User presses *Reconnect*.
 */
const pendingAuthorizations = computed(() =>
  (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.pendingAuthorization !== undefined &&
      connection.state !== "revoked",
  ),
);
const togglingConnectionTypeId = ref<string>();

const apiKeyPackageId = ref<string>();
const apiKeyConnectionTypeId = ref<string>();
const apiKeyLabel = ref("");
const apiKey = ref("");

onMounted(() => {
  void web.value.loadPluginCatalog();
});

function connectionCount(item: PluginCatalogItem): number {
  return (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === item.packageId &&
      connection.state !== "revoked" &&
      (!item.connectorId ||
        connection.safeMetadata.connectorId === item.connectorId) &&
      (!item.connectionId || connection.connectionId === item.connectionId),
  ).length;
}

function credentiallessConnection(item: PluginCatalogItem) {
  const connectionType = item.connectionTypes[0];
  if (connectionType?.authorizationKind !== "none") return undefined;
  return (web.value.userSettings?.connections ?? []).find(
    (connection) =>
      connection.packageId === item.packageId &&
      connection.connectionTypeId === connectionType.id &&
      connection.state !== "revoked",
  );
}

async function toggleCredentialless(item: PluginCatalogItem): Promise<void> {
  const connectionType = item.connectionTypes[0];
  if (connectionType?.authorizationKind !== "none") return;
  togglingConnectionTypeId.value = connectionType.id;
  try {
    const connection = credentiallessConnection(item);
    if (!connection) {
      await web.value.createConnection({
        packageId: item.packageId,
        connectionTypeId: connectionType.id,
        label: item.displayName,
      });
    } else {
      await web.value.setConnectionEnabled(
        connection.connectionId,
        connection.state !== "ready",
      );
    }
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not update Connection";
  } finally {
    togglingConnectionTypeId.value = undefined;
  }
}

/** Start whichever authorization the card's Connection Type declares. */
const labelingConnector = ref<string>();
const accountAlias = ref("");

function beginConnect(item: PluginCatalogItem): void {
  const connectionType = item.connectionTypes[0];
  if (!connectionType) return;
  if (connectionType.authorizationKind === "api-key") {
    apiKeyPackageId.value = item.packageId;
    apiKeyConnectionTypeId.value = connectionType.id;
    apiKeyLabel.value = item.displayName;
    apiKey.value = "";
    return;
  }
  if (item.connectorId) {
    labelingConnector.value = item.connectorId;
    accountAlias.value = "";
    return;
  }
  void connect(item.packageId, connectionType.id, item.connectorId);
}

function cancelApiKeyConnection(): void {
  apiKey.value = "";
  apiKeyPackageId.value = undefined;
  apiKeyConnectionTypeId.value = undefined;
}

async function connectApiKey(): Promise<void> {
  if (!apiKeyPackageId.value || !apiKeyConnectionTypeId.value) return;
  try {
    await web.value.createApiKeyConnection({
      packageId: apiKeyPackageId.value,
      connectionTypeId: apiKeyConnectionTypeId.value,
      label: apiKeyLabel.value,
      apiKey: apiKey.value,
    });
    cancelApiKeyConnection();
  } catch (error) {
    apiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not create Connection";
  }
}

async function connect(
  packageId: string,
  connectionTypeId: string,
  connectorId?: string,
  alias?: string,
): Promise<void> {
  try {
    const redirectUrl = await web.value.startConnection(
      packageId,
      connectionTypeId,
      connectorId,
      alias,
    );
    if (redirectUrl) {
      await web.value.openConnectionAuthorization(redirectUrl);
    }
    await web.value.loadPluginCatalog();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not start Connection";
  }
}
</script>

<template>
  <div class="connections-surface">
    <UiAnchor
      anchor="user-connections"
      label="Connectors"
      :href="connectionsLink"
      class="settings-row"
    >
      <p class="field-hint">
        Connect an account or service once and every Bot you own can use it.
      </p>

      <p
        v-if="connectionReturn"
        class="connection-return"
        :class="{
          'connection-return--failed': connectionReturn.status === 'failed',
        }"
        role="status"
      >
        {{ connectionReturnMessage }}
        <UiButton @click="dismissConnectionReturn">Dismiss</UiButton>
      </p>

      <p
        v-if="Object.keys(web.connectorCatalogErrors ?? {}).length"
        role="status"
        class="field-hint"
      >
        Some connectors could not be refreshed.
        <UiButton @click="web.loadPluginCatalog()">Try again</UiButton>
      </p>
      <label class="connector-search"
        ><span>Find a connector</span
        ><input
          v-model="search"
          type="search"
          placeholder="Search Gmail, Calendar, or a service…"
      /></label>
      <div class="connector-grid">
        <article
          v-for="item in connectors"
          :key="`${item.packageId}/${item.connectorId ?? item.connectionId ?? ''}`"
          class="connector-card"
        >
          <div class="connector-summary">
            <img
              v-if="item.connectorIcon"
              class="connector-logo"
              :src="item.connectorIcon"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <span v-else class="connector-logo" aria-hidden="true">
              {{ item.displayName.slice(0, 1) }}
            </span>
            <span class="connector-copy">
              <strong>{{ item.displayName }}</strong>
              <small>{{
                item.connectorDescription ?? connectorStatus(item)
              }}</small>
            </span>
            <UiButton
              v-if="item.connectionTypes[0]?.authorizationKind === 'none'"
              :disabled="
                togglingConnectionTypeId === item.connectionTypes[0]?.id
              "
              @click="toggleCredentialless(item)"
            >
              {{
                credentiallessConnection(item)?.state === "ready"
                  ? "Disable"
                  : "Enable"
              }}
            </UiButton>
            <UiButton
              v-else-if="
                !item.connectionId &&
                (connectionCount(item) === 0 ||
                  item.connectionTypes[0]?.allowMultiple)
              "
              @click="beginConnect(item)"
            >
              {{
                connectionCount(item) === 0 ? "Connect" : "Add another account"
              }}
            </UiButton>
          </div>

          <form
            v-if="item.connectorId && labelingConnector === item.connectorId"
            class="api-key-form"
            @submit.prevent="
              connect(
                item.packageId,
                item.connectionTypes[0]!.id,
                item.connectorId,
                accountAlias.trim(),
              )
            "
          >
            <label
              ><span>Account label</span
              ><input
                v-model="accountAlias"
                placeholder="Work email or personal account"
                maxlength="120"
                required
            /></label>
            <p class="field-hint">
              Choose a name so you can recognize this account later.
            </p>
            <div class="api-key-actions">
              <UiButton @click="labelingConnector = undefined">Cancel</UiButton
              ><UiButton type="submit" variant="primary"
                >Continue to sign in</UiButton
              >
            </div>
          </form>
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
            <div class="api-key-actions">
              <UiButton @click="cancelApiKeyConnection">Cancel</UiButton>
              <UiButton type="submit" variant="primary">
                Connect account
              </UiButton>
            </div>
          </form>

          <PackageSettingsForm :item="item" />
        </article>
      </div>

      <div v-if="connectors.length === 0" class="connections-empty">
        <p>
          {{
            search.trim()
              ? "No connectors match your search."
              : "Your connectors will appear here when they are available."
          }}
        </p>
        <UiButton
          v-if="!search.trim()"
          type="button"
          @click="surfaces.open('plugins')"
        >
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
.connector-search {
  display: grid;
  gap: 0.4rem;
  margin: 1rem 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
.connector-search input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.75rem;
  border: 1px solid var(--frock-border);
  border-radius: 0.65rem;
  background: var(--frock-surface);
  color: var(--frock-text);
}
img.connector-logo {
  object-fit: contain;
  padding: 0.3rem;
}

.connections-surface {
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

.connect-cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.connect-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
}

.connect-card-copy {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.connect-card-copy span {
  color: var(--frock-text-muted);
}

.connector-grid {
  display: grid;
  gap: 12px;
}

.connector-card {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
}

.connector-summary {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px;
}

.connector-logo {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 12px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-weight: 800;
}

.connector-copy {
  min-width: 0;
}

.connector-copy strong,
.connector-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.connector-copy strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.connector-copy small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.connector-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.connector-actions :deep(.ui-button) {
  min-height: 28px;
  padding: 0 10px;
  font-size: var(--frock-text-sm);
}

.connection-return {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-accent);
}

.connection-return--failed {
  background: var(--frock-surface-danger, var(--frock-surface-accent));
}

.connections-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.connections-empty p {
  margin: 0;
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

.api-key-form input,
.api-key-form select {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.api-key-form textarea {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-family: inherit;
  font-size: var(--frock-text-base);
  resize: vertical;
}

.api-key-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.connection-failure {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
