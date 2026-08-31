<script setup lang="ts">
import { UiButton, UiIcon } from "@frockbot/client-ui";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  frockBotWebDataKey,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;
const search = ref("");
const expandedPackageId = ref<string>();
const apiKeyPackageId = ref<string>();
const apiKeyConnectionTypeId = ref<string>();
const apiKeyLabel = ref("");
const apiKey = ref("");
/**
 * The MCP server form. A remote MCP server is a Connection like any other, but
 * it needs its URL and transport as well as an optional key, so the generic
 * API-key form cannot carry it. Both commands it can send are the ordinary
 * Connection commands: `connection/create-api-key` when a key is given, and
 * `connection/create` when the server is public.
 */
const MCP_PACKAGE_ID = "mcp";
const mcpFormOpen = ref(false);
const mcpLabel = ref("");
const mcpUrl = ref("");
const mcpTransport = ref<"streamable-http" | "sse">("streamable-http");
const mcpApiKey = ref("");
const rotatingConnectionId = ref<string>();
const rotationKey = ref("");
const labelingConnectionId = ref<string>();
const connectionLabel = ref("");
const filteredCatalog = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return web.value.pluginCatalog;
  return web.value.pluginCatalog.filter(
    (item) =>
      item.displayName.toLocaleLowerCase().includes(query) ||
      item.connectionTypes.some((connection) =>
        connection.displayName.toLocaleLowerCase().includes(query),
      ),
  );
});

const catalogSearch = ref("");
const openCatalogId = ref<string>();
const openCatalogEntry = ref<CatalogEntryV1>();
const catalogEntryLoading = ref(false);
const uninstallingPackageId = ref<string>();
const filteredPackageCatalog = computed(() => {
  const query = catalogSearch.value.trim().toLocaleLowerCase();
  if (!query) return web.value.packageCatalog;
  return web.value.packageCatalog.filter(
    (entry) =>
      entry.displayName.toLocaleLowerCase().includes(query) ||
      entry.packageId.toLocaleLowerCase().includes(query) ||
      entry.description.toLocaleLowerCase().includes(query),
  );
});

onMounted(() => {
  void web.value.loadPluginCatalog();
  void web.value.loadPackageCatalog();
});

/**
 * Opening an entry loads its detail from the same generation the index came
 * from, so the panel never describes a different generation than the row.
 */
async function toggleCatalogEntry(entry: CatalogIndexEntryV1): Promise<void> {
  if (openCatalogId.value === entry.catalogId) {
    openCatalogId.value = undefined;
    openCatalogEntry.value = undefined;
    return;
  }
  openCatalogId.value = entry.catalogId;
  openCatalogEntry.value = undefined;
  catalogEntryLoading.value = true;
  try {
    const detail = await web.value.loadCatalogEntry(entry.catalogId);
    if (openCatalogId.value === entry.catalogId) {
      openCatalogEntry.value = detail;
    }
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not load the entry";
  } finally {
    catalogEntryLoading.value = false;
  }
}

async function installFromCatalog(entry: CatalogIndexEntryV1): Promise<void> {
  try {
    await web.value.installCatalogPackage(entry);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not install the Package";
  }
}

async function confirmUninstall(packageId: string): Promise<void> {
  try {
    await web.value.uninstallPackage(packageId);
    uninstallingPackageId.value = undefined;
    if (openCatalogId.value === packageId) {
      openCatalogId.value = undefined;
      openCatalogEntry.value = undefined;
    }
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : "Could not uninstall the Package";
  }
}

function isPackageInstalled(packageId: string): boolean {
  return Boolean(
    web.value.userSettings?.packages.some(
      (item) => item.packageId === packageId && item.state === "installed",
    ),
  );
}

/**
 * The accounts a card speaks for. A revoked Connection is a tombstone the User
 * has already dismissed, so it neither counts towards the card's summary nor
 * appears in its accounts list.
 */
function packageConnections(packageId: string): ConnectionView[] {
  return (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === packageId && connection.state !== "revoked",
  );
}

type StatusTone = "ready" | "muted" | "attention";

interface CardStatus {
  tone: StatusTone;
  label: string;
}

/** The single status a connected card shows on its summary row. */
function cardStatus(packageId: string): CardStatus {
  const connections = packageConnections(packageId);
  if (connections.some((connection) => connection.state === "ready")) {
    return {
      tone: "ready",
      label:
        connections.length > 1 ? `${connections.length} accounts` : "Connected",
    };
  }
  if (connections.some((connection) => connection.state === "disabled")) {
    return { tone: "muted", label: "Disabled" };
  }
  if (connections.some((connection) => connection.state === "authorizing")) {
    return { tone: "muted", label: "Connecting" };
  }
  if (connections.some((connection) => connection.state === "revoking")) {
    return { tone: "muted", label: "Disconnecting" };
  }
  return { tone: "attention", label: "Needs attention" };
}

function connectionTone(connection: ConnectionView): StatusTone {
  if (connection.state === "ready") return "ready";
  if (connection.state === "failed") return "attention";
  if (connection.state === "reconciliation-required") return "attention";
  return "muted";
}

function primaryConnectionType(
  item: PluginCatalogItem,
): PluginCatalogItem["connectionTypes"][number] | undefined {
  return item.connectionTypes[0];
}

function isExpanded(packageId: string): boolean {
  return expandedPackageId.value === packageId;
}

function toggleExpanded(packageId: string): void {
  expandedPackageId.value = isExpanded(packageId) ? undefined : packageId;
}

async function install(packageId: string, version: string): Promise<void> {
  try {
    await web?.value.installPackage(packageId, version);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add Plugin";
  }
}

function beginApiKeyConnection(
  packageId: string,
  connectionTypeId: string,
  displayName: string,
): void {
  apiKeyPackageId.value = packageId;
  apiKeyConnectionTypeId.value = connectionTypeId;
  apiKeyLabel.value = displayName;
  apiKey.value = "";
}

function beginMcpConnection(): void {
  mcpFormOpen.value = true;
  mcpLabel.value = "";
  mcpUrl.value = "";
  mcpTransport.value = "streamable-http";
  mcpApiKey.value = "";
}

function cancelMcpConnection(): void {
  mcpFormOpen.value = false;
  mcpApiKey.value = "";
}

async function addMcpServer(): Promise<void> {
  const settings = {
    url: mcpUrl.value.trim(),
    transport: mcpTransport.value,
  };
  try {
    if (mcpApiKey.value) {
      await web.value.createApiKeyConnection({
        packageId: MCP_PACKAGE_ID,
        connectionTypeId: "mcp-remote-key",
        label: mcpLabel.value,
        apiKey: mcpApiKey.value,
        settings,
      });
    } else {
      await web.value.createConnection({
        packageId: MCP_PACKAGE_ID,
        connectionTypeId: "mcp-remote",
        label: mcpLabel.value,
        settings,
      });
    }
    cancelMcpConnection();
    expandedPackageId.value = undefined;
  } catch (error) {
    mcpApiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add the MCP server";
  }
}

/** Start whichever authorization the card's Connection type declares. */
function beginConnect(item: PluginCatalogItem): void {
  if (item.packageId === MCP_PACKAGE_ID) {
    beginMcpConnection();
    return;
  }
  const connectionType = primaryConnectionType(item);
  if (!connectionType) return;
  if (connectionType.authorizationKind === "api-key") {
    beginApiKeyConnection(item.packageId, connectionType.id, item.displayName);
    return;
  }
  void connect(item.packageId, connectionType.id);
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
    apiKey.value = "";
    apiKeyPackageId.value = undefined;
    apiKeyConnectionTypeId.value = undefined;
    expandedPackageId.value = undefined;
  } catch (error) {
    apiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not create Connection";
  }
}

function cancelApiKeyConnection(): void {
  apiKey.value = "";
  apiKeyPackageId.value = undefined;
  apiKeyConnectionTypeId.value = undefined;
}

async function rotateApiKey(connectionId: string): Promise<void> {
  try {
    await web.value.rotateApiKeyConnection(connectionId, rotationKey.value);
    rotationKey.value = "";
    rotatingConnectionId.value = undefined;
  } catch (error) {
    rotationKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not rotate credential";
  }
}

async function connect(
  packageId: string,
  connectionTypeId: string,
): Promise<void> {
  try {
    const redirectUrl = await web?.value.startConnection(
      packageId,
      connectionTypeId,
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

async function revoke(packageId: string, connectionId: string): Promise<void> {
  try {
    await web?.value.revokeConnection(packageId, connectionId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not revoke Connection";
  }
}

function beginLabeling(connection: ConnectionView): void {
  labelingConnectionId.value = connection.connectionId;
  connectionLabel.value = connection.displayName;
}

async function saveLabel(connectionId: string): Promise<void> {
  try {
    await web.value.updateConnectionLabel(connectionId, connectionLabel.value);
    labelingConnectionId.value = undefined;
    connectionLabel.value = "";
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not rename Connection";
  }
}

async function refreshModels(connectionId: string): Promise<void> {
  try {
    await web.value.refreshConnectionModels(connectionId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not refresh models";
  }
}

async function setEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  try {
    await web.value.setConnectionEnabled(connectionId, enabled);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not update Connection";
  }
}

async function disconnect(connectionId: string): Promise<void> {
  try {
    await web.value.disconnectConnection(connectionId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not disconnect";
  }
}
</script>

<template>
  <div class="plugins-surface">
    <label class="plugin-search">
      <UiIcon name="search" />
      <input
        v-model="search"
        placeholder="Search Plugins"
        aria-label="Search Plugins"
      />
    </label>
    <p class="plugin-intro">
      Add secure connections and capabilities to your Bots.
    </p>
    <div class="plugin-grid">
      <article
        v-for="item in filteredCatalog"
        :key="item.packageId"
        class="plugin-card"
      >
        <button
          v-if="packageConnections(item.packageId).length"
          type="button"
          class="plugin-summary plugin-summary--interactive"
          :aria-expanded="isExpanded(item.packageId)"
          :aria-controls="`plugin-accounts-${item.packageId}`"
          :aria-label="`${item.displayName} accounts, ${cardStatus(item.packageId).label}`"
          @click="toggleExpanded(item.packageId)"
        >
          <span class="plugin-logo" aria-hidden="true">
            {{ item.displayName.slice(0, 1) }}
          </span>
          <span class="plugin-card-copy">
            <strong>{{ item.displayName }}</strong>
            <small>
              {{
                item.connectionTypes
                  .map((connection) => connection.displayName)
                  .join(", ")
              }}
            </small>
          </span>
          <span
            class="plugin-status"
            :class="`plugin-status--${cardStatus(item.packageId).tone}`"
          >
            <span
              v-if="cardStatus(item.packageId).tone === 'ready'"
              class="plugin-status-badge"
              aria-hidden="true"
            >
              <UiIcon name="check" :size="12" :weight="2.5" />
            </span>
            <span v-else class="plugin-status-dot" aria-hidden="true" />
            {{ cardStatus(item.packageId).label }}
          </span>
          <UiIcon
            class="plugin-chevron"
            :class="{ 'plugin-chevron--open': isExpanded(item.packageId) }"
            name="chevrons-right"
            size="sm"
          />
        </button>
        <div v-else class="plugin-summary">
          <span class="plugin-logo" aria-hidden="true">
            {{ item.displayName.slice(0, 1) }}
          </span>
          <span class="plugin-card-copy">
            <strong>{{ item.displayName }}</strong>
            <small>
              {{
                item.connectionTypes
                  .map((connection) => connection.displayName)
                  .join(", ")
              }}
            </small>
          </span>
          <UiButton
            v-if="isPackageInstalled(item.packageId)"
            @click="beginConnect(item)"
          >
            Connect
          </UiButton>
          <UiButton
            v-else
            variant="primary"
            @click="install(item.packageId, item.version)"
          >
            Add
          </UiButton>
        </div>

        <div
          :id="`plugin-accounts-${item.packageId}`"
          class="plugin-accounts"
          :class="{ 'plugin-accounts--open': isExpanded(item.packageId) }"
          :inert="isExpanded(item.packageId) ? undefined : true"
        >
          <div class="plugin-accounts-inner">
            <div
              v-for="connection in packageConnections(item.packageId)"
              :key="connection.connectionId"
              class="plugin-account"
            >
              <div class="account-identity">
                <span
                  class="account-dot"
                  :class="`account-dot--${connectionTone(connection)}`"
                  aria-hidden="true"
                />
                <strong>{{ connection.displayName }}</strong>
                <small>{{ connection.state }}</small>
                <small v-if="connection.modelCatalog">
                  · models {{ connection.modelCatalog.state }}
                </small>
              </div>
              <div class="account-actions">
                <UiButton @click="beginLabeling(connection)">Rename</UiButton>
                <template v-if="connection.authorization?.kind === 'api-key'">
                  <UiButton
                    v-if="
                      connection.modelCatalog && connection.state === 'ready'
                    "
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
                      connection.state === 'ready' ||
                      connection.state === 'disabled'
                    "
                    @click="rotatingConnectionId = connection.connectionId"
                  >
                    Rotate key
                  </UiButton>
                  <UiButton
                    v-if="connection.state !== 'revoking'"
                    variant="danger"
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
              <p
                v-if="connection.failure"
                class="connection-failure"
                role="alert"
              >
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
            <div
              v-if="primaryConnectionType(item)?.allowMultiple"
              class="account-add"
            >
              <UiButton @click="beginConnect(item)">
                Add another account
              </UiButton>
            </div>
          </div>
        </div>

        <form
          v-if="mcpFormOpen && item.packageId === MCP_PACKAGE_ID"
          class="api-key-form"
          @submit.prevent="addMcpServer"
        >
          <label>
            <span>Server name</span>
            <input v-model="mcpLabel" maxlength="120" required />
          </label>
          <label>
            <span>Server URL</span>
            <input
              v-model="mcpUrl"
              type="url"
              inputmode="url"
              placeholder="https://example.com/mcp"
              maxlength="2048"
              required
            />
          </label>
          <label>
            <span>Transport</span>
            <select v-model="mcpTransport">
              <option value="streamable-http">Streamable HTTP</option>
              <option value="sse">Server-sent events</option>
            </select>
          </label>
          <label>
            <span>API key (optional)</span>
            <input
              v-model="mcpApiKey"
              type="password"
              autocomplete="new-password"
            />
          </label>
          <div class="api-key-actions">
            <UiButton @click="cancelMcpConnection">Cancel</UiButton>
            <UiButton type="submit" variant="primary">Add server</UiButton>
          </div>
        </form>

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
            <UiButton type="submit" variant="primary">Connect account</UiButton>
          </div>
        </form>
      </article>
    </div>

    <p
      v-if="web.pluginCatalog.length === 0 && !web.settingsError"
      class="plugin-empty"
    >
      No connection Packages are available.
    </p>

    <section class="catalog" aria-labelledby="package-catalog-heading">
      <h3 id="package-catalog-heading" class="catalog-heading">
        Package Catalog
      </h3>
      <p class="plugin-intro">
        Packages published to the remote Catalog. Installing one makes it
        available to every Bot you own; a Bot still needs an explicit Assignment
        before it can use anything.
      </p>
      <label class="plugin-search">
        <UiIcon name="search" />
        <input
          v-model="catalogSearch"
          placeholder="Search the Catalog"
          aria-label="Search the Package Catalog"
        />
      </label>
      <p v-if="web.packageCatalogGeneration" class="catalog-generation">
        Generation {{ web.packageCatalogGeneration }}
      </p>
      <div class="plugin-grid">
        <article
          v-for="entry in filteredPackageCatalog"
          :key="entry.catalogId"
          class="plugin-card"
        >
          <button
            type="button"
            class="plugin-summary plugin-summary--interactive"
            :aria-expanded="openCatalogId === entry.catalogId"
            :aria-controls="`catalog-detail-${entry.catalogId}`"
            @click="toggleCatalogEntry(entry)"
          >
            <span class="plugin-logo" aria-hidden="true">
              {{ entry.displayName.slice(0, 1) }}
            </span>
            <span class="plugin-card-copy">
              <strong>{{ entry.displayName }}</strong>
              <small>{{ entry.description }}</small>
            </span>
            <span class="catalog-version">{{ entry.version }}</span>
            <UiIcon
              class="plugin-chevron"
              :class="{
                'plugin-chevron--open': openCatalogId === entry.catalogId,
              }"
              name="chevrons-right"
              size="sm"
            />
          </button>
          <div
            :id="`catalog-detail-${entry.catalogId}`"
            class="plugin-accounts"
            :class="{
              'plugin-accounts--open': openCatalogId === entry.catalogId,
            }"
            :inert="openCatalogId === entry.catalogId ? undefined : true"
          >
            <div class="plugin-accounts-inner">
              <div class="catalog-detail">
                <p v-if="catalogEntryLoading" class="catalog-note">Loading…</p>
                <template v-else-if="openCatalogEntry">
                  <p class="catalog-note">{{ openCatalogEntry.description }}</p>
                  <dl class="catalog-facts">
                    <div>
                      <dt>Package</dt>
                      <dd>{{ openCatalogEntry.packageId }}</dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd>{{ openCatalogEntry.version }}</dd>
                    </div>
                    <div v-if="openCatalogEntry.homepage">
                      <dt>Homepage</dt>
                      <dd>
                        <a
                          :href="openCatalogEntry.homepage"
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          {{ openCatalogEntry.homepage }}
                        </a>
                      </dd>
                    </div>
                  </dl>
                </template>
                <div
                  v-if="uninstallingPackageId === entry.packageId"
                  class="catalog-confirm"
                  role="alert"
                >
                  <p>
                    Uninstalling {{ entry.displayName }} removes it from every
                    Bot. Assignments that depend on it are not deleted: they
                    become unavailable and stay visible so you can repair or
                    remove them. Connections and their credentials are kept.
                  </p>
                  <div class="account-actions">
                    <UiButton @click="uninstallingPackageId = undefined">
                      Keep it
                    </UiButton>
                    <UiButton
                      variant="danger"
                      @click="confirmUninstall(entry.packageId)"
                    >
                      Uninstall
                    </UiButton>
                  </div>
                </div>
                <div v-else class="account-actions">
                  <UiButton
                    v-if="isPackageInstalled(entry.packageId)"
                    variant="danger"
                    @click="uninstallingPackageId = entry.packageId"
                  >
                    Uninstall
                  </UiButton>
                  <UiButton
                    v-else
                    variant="primary"
                    @click="installFromCatalog(entry)"
                  >
                    Install
                  </UiButton>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>
      <p
        v-if="web.packageCatalog.length === 0 && !web.settingsError"
        class="plugin-empty"
      >
        The Catalog has nothing to offer yet.
      </p>
      <p v-else-if="filteredPackageCatalog.length === 0" class="plugin-empty">
        No Catalog entry matches that search.
      </p>
    </section>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
  </div>
</template>

<style scoped>
.plugins-surface {
  padding: 24px;
}

.plugin-search {
  display: flex;
  height: 42px;
  align-items: center;
  gap: 9px;
  padding: 0 13px;
  border: 1px solid var(--frock-border);
  border-radius: 999px;
  color: var(--frock-text-subtle);
  background: var(--frock-surface-raised);
}

.plugin-search:focus-within {
  border-color: var(--frock-border-focus);
  box-shadow: 0 0 0 3px var(--frock-focus-ring);
}

.plugin-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
}

.plugin-intro,
.plugin-empty {
  margin: 14px 0 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
}

.plugin-grid {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.plugin-card {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
  transition:
    transform var(--frock-motion-fast),
    box-shadow var(--frock-motion-fast);
}

.plugin-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--frock-shadow-control);
}

.plugin-summary {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border: 0;
  border-radius: var(--frock-radius-control);
  color: inherit;
  background: transparent;
  text-align: left;
}

.plugin-summary--interactive {
  grid-template-columns: 44px minmax(0, 1fr) auto 16px;
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.plugin-summary--interactive:hover {
  background: var(--frock-fill-hover);
}

.plugin-card-copy strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.plugin-logo {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 12px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-weight: 800;
}

.plugin-card-copy {
  min-width: 0;
}

.plugin-card-copy strong,
.plugin-card-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.plugin-card-copy small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.plugin-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--frock-text-sm);
  font-weight: 700;
  white-space: nowrap;
}

.plugin-status--ready {
  color: var(--frock-success);
}

.plugin-status--muted {
  color: var(--frock-text-muted);
}

.plugin-status--attention {
  color: var(--frock-danger-text);
}

.plugin-status-badge {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 999px;
  color: var(--frock-on-accent);
  background: var(--frock-success);
}

.plugin-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentcolor;
}

.plugin-chevron {
  color: var(--frock-text-subtle);
  transform: rotate(0deg);
  transition: transform var(--frock-motion-panel);
}

.plugin-chevron--open {
  transform: rotate(90deg);
}

.plugin-accounts {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--frock-motion-panel),
    opacity var(--frock-motion-panel);
}

.plugin-accounts--open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.plugin-accounts-inner {
  min-height: 0;
  overflow: hidden;
}

.plugin-account {
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

.account-identity strong {
  overflow: hidden;
  font-size: var(--frock-text-base);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.account-identity small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  text-transform: capitalize;
}

.account-dot {
  width: 8px;
  height: 8px;
  align-self: center;
  border-radius: 999px;
}

.account-dot--ready {
  background: var(--frock-success);
}

.account-dot--muted {
  background: var(--frock-text-subtle);
}

.account-dot--attention {
  background: var(--frock-danger-text);
}

.account-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.account-add {
  padding: 12px 8px;
  border-top: 1px solid var(--frock-border);
}

.account-actions :deep(.ui-button),
.account-add :deep(.ui-button),
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
.inline-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
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

.catalog {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--frock-border);
}

.catalog-heading {
  margin: 0 0 4px;
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.catalog .plugin-search {
  margin-top: 14px;
}

.catalog-generation {
  margin: 10px 0 0;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.catalog-version {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  white-space: nowrap;
}

.catalog-detail {
  display: grid;
  gap: 12px;
  padding: 12px 8px;
  border-top: 1px solid var(--frock-border);
}

.catalog-note {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.catalog-facts {
  display: grid;
  gap: 6px;
  margin: 0;
}

.catalog-facts div {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 8px;
}

.catalog-facts dt {
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.catalog-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--frock-text-sm);
}

.catalog-confirm {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-subtle);
}

.catalog-confirm p {
  margin: 0;
  font-size: var(--frock-text-sm);
}

.settings-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
