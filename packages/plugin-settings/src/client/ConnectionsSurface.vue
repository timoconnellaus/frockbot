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
  return (
    web.value.pluginCatalog.find((item) => item.packageId === packageId)
      ?.displayName ?? packageId
  );
}

function dismissConnectionReturn(): void {
  web.value.connectionReturn = undefined;
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
      return dynamic.flatMap((type) =>
        (
          web.value.connectorCatalog?.[`${item.packageId}/${type.id}`] ?? []
        ).map((entry) => ({
          ...item,
          displayName: entry.name,
          connectorId: entry.id,
          connectorDescription: entry.description,
          connectorIcon: entry.icon,
          connectionTypes: [type],
        })),
      );
    if (item.packageId === MCP_PACKAGE_ID)
      return [
        ...mcpServers.value.map((server) => ({
          ...item,
          connectionId: server.serverId,
          displayName: server.label,
          connectorDescription: "Tools from your connected server",
        })),
        {
          ...item,
          connectionId: "new-server",
          displayName: "Custom server",
          connectorDescription:
            "Connect a service using its MCP server address",
        },
      ];
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
const reconnectingConnectionId = ref<string>();
const togglingConnectionTypeId = ref<string>();

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
/**
 * How the custom server authenticates. `oauth` is not a third field on the
 * same form but a different command: it starts an authorization the host
 * authors a redirect for, rather than creating a Connection from a secret the
 * User pasted.
 */
const mcpAuthMode = ref<"none" | "key" | "oauth">("none");
const mcpScope = ref("");
const mcpClientId = ref("");

/**
 * The MCP lifecycle panel: the server records the User Durable Object
 * owns, which the Connection rows cannot show — a server's `needs-auth` or
 * `error` state, when it last handshook, what its instructions are, and the
 * refusals this build recorded rather than performed.
 */
const editingInstructionsFor = ref<string>();
const instructionsDraft = ref("");
const restartingServerId = ref<string>();
const mcpServers = computed(() => web.value.mcpServers?.servers ?? []);
const mcpRefusals = computed(() => web.value.mcpServers?.refusals ?? []);

onMounted(() => {
  void web.value.loadPluginCatalog();
  void web.value.loadMcpServers();
});

function mcpStateLabel(state: string): string {
  if (state === "needs-auth") return "Needs authorization";
  if (state === "connecting") return "Connecting";
  if (state === "error") return "Error";
  return "Ready";
}

function handshakeLabel(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function beginInstructions(serverId: string, instructions: string): void {
  editingInstructionsFor.value = serverId;
  instructionsDraft.value = instructions;
}

function cancelInstructions(): void {
  editingInstructionsFor.value = undefined;
  instructionsDraft.value = "";
}

async function saveInstructions(serverId: string): Promise<void> {
  await web.value.setMcpInstructions(serverId, instructionsDraft.value);
  cancelInstructions();
}

async function restartServer(serverId: string): Promise<void> {
  restartingServerId.value = serverId;
  try {
    await web.value.restartMcpServer(serverId);
  } finally {
    restartingServerId.value = undefined;
  }
}

/**
 * *Reconnect*: the authenticated command that mints a fresh redirect, with
 * fresh PKCE and a fresh signed state. Nothing was stored waiting for this —
 * the card only ever said that a decision was pending.
 */
async function reconnect(connectionId: string): Promise<void> {
  reconnectingConnectionId.value = connectionId;
  try {
    const redirect = await web.value.startMcpAuthorization({ connectionId });
    if (redirect) await web.value.openConnectionAuthorization(redirect);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not reconnect";
  } finally {
    reconnectingConnectionId.value = undefined;
  }
}

function connectionCount(item: PluginCatalogItem): number {
  return (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === item.packageId &&
      connection.state !== "revoked" &&
      (!item.connectorId ||
        connection.safeMetadata.toolkitSlug === item.connectorId) &&
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

function beginMcpConnection(): void {
  mcpFormOpen.value = true;
  mcpLabel.value = "";
  mcpUrl.value = "";
  mcpTransport.value = "streamable-http";
  mcpApiKey.value = "";
  mcpAuthMode.value = "none";
  mcpScope.value = "";
  mcpClientId.value = "";
}

function cancelMcpConnection(): void {
  mcpFormOpen.value = false;
  mcpApiKey.value = "";
  mcpAuthMode.value = "none";
}

async function addMcpServer(): Promise<void> {
  const settings = {
    url: mcpUrl.value.trim(),
    transport: mcpTransport.value,
  };
  try {
    if (mcpAuthMode.value === "oauth") {
      // No secret is collected and none is stored: the server is discovered,
      // a client is registered, and the redirect is authored by the host.
      const redirect = await web.value.startMcpAuthorization({
        label: mcpLabel.value,
        settings: {
          ...settings,
          ...(mcpScope.value.trim() ? { scope: mcpScope.value.trim() } : {}),
          ...(mcpClientId.value.trim()
            ? { "client-id": mcpClientId.value.trim() }
            : {}),
        },
      });
      cancelMcpConnection();
      if (redirect) await web.value.openConnectionAuthorization(redirect);
      return;
    }
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
  } catch (error) {
    mcpApiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Couldn't add that server.";
  }
}

/** Start whichever authorization the card's Connection Type declares. */
function beginConnect(item: PluginCatalogItem): void {
  if (item.packageId === MCP_PACKAGE_ID) {
    beginMcpConnection();
    return;
  }
  const connectionType = item.connectionTypes[0];
  if (!connectionType) return;
  if (connectionType.authorizationKind === "api-key") {
    apiKeyPackageId.value = item.packageId;
    apiKeyConnectionTypeId.value = connectionType.id;
    apiKeyLabel.value = item.displayName;
    apiKey.value = "";
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
): Promise<void> {
  try {
    const redirectUrl = await web.value.startConnection(
      packageId,
      connectionTypeId,
      connectorId,
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
              <small>
                {{
                  item.connectorDescription ??
                  item.connectionTypes[0]?.displayName
                }}
              </small>
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
                (!item.connectionId || item.connectionId === 'new-server') &&
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

          <PackageAccounts :item="item" />

          <div
            v-if="
              item.packageId === MCP_PACKAGE_ID &&
              (mcpServers.length > 0 || mcpRefusals.length > 0)
            "
            class="mcp-status"
          >
            <div
              v-for="server in mcpServers.filter(
                (server) => server.serverId === item.connectionId,
              )"
              :key="server.serverId"
              class="mcp-server"
            >
              <div class="mcp-server-head">
                <span class="mcp-server-name">{{ server.label }}</span>
                <span :class="['mcp-state', `mcp-state-${server.state}`]">
                  {{ mcpStateLabel(server.state) }}
                </span>
              </div>
              <p class="mcp-meta">
                {{ server.toolCount }} tools · Last checked
                {{ handshakeLabel(server.lastHandshakeAt) }}
              </p>
              <p v-if="server.failure" class="connection-failure">
                {{ server.failure.message }}
              </p>
              <p v-if="server.instructions" class="mcp-instructions">
                {{ server.instructions }}
              </p>
              <div class="connector-actions">
                <UiButton
                  v-if="server.state === 'needs-auth'"
                  :disabled="reconnectingConnectionId === server.serverId"
                  @click="reconnect(server.serverId)"
                  >Reconnect</UiButton
                >
                <UiButton
                  @click="
                    beginInstructions(
                      server.serverId,
                      server.instructions ?? '',
                    )
                  "
                >
                  Instructions
                </UiButton>
                <UiButton
                  :disabled="restartingServerId === server.serverId"
                  @click="restartServer(server.serverId)"
                >
                  {{
                    restartingServerId === server.serverId
                      ? "Restarting…"
                      : "Restart"
                  }}
                </UiButton>
              </div>
              <form
                v-if="editingInstructionsFor === server.serverId"
                class="api-key-form"
                @submit.prevent="saveInstructions(server.serverId)"
              >
                <label>
                  <span>Instructions for this server's tools</span>
                  <textarea
                    v-model="instructionsDraft"
                    maxlength="4096"
                    rows="4"
                  ></textarea>
                </label>
                <div class="api-key-actions">
                  <UiButton @click="cancelInstructions">Cancel</UiButton>
                  <UiButton type="submit" variant="primary">Save</UiButton>
                </div>
              </form>
            </div>
            <p
              v-for="refusal in mcpRefusals"
              :key="refusal.refusalId"
              class="connection-failure"
            >
              {{ refusal.message }}
            </p>
          </div>

          <form
            v-if="mcpFormOpen && item.connectionId === 'new-server'"
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
              <span>Authentication</span>
              <select v-model="mcpAuthMode">
                <option value="none">None (public server)</option>
                <option value="key">API key</option>
                <option value="oauth">OAuth</option>
              </select>
            </label>
            <label v-if="mcpAuthMode === 'key'">
              <span>API key</span>
              <input
                v-model="mcpApiKey"
                type="password"
                autocomplete="new-password"
              />
            </label>
            <template v-if="mcpAuthMode === 'oauth'">
              <label>
                <span>Scope (optional)</span>
                <input v-model="mcpScope" maxlength="1024" autocomplete="off" />
              </label>
              <label>
                <span>Client ID (optional)</span>
                <input
                  v-model="mcpClientId"
                  maxlength="512"
                  autocomplete="off"
                />
              </label>
              <p class="field-hint">
                Leave both empty unless the server gave you specific values.
                You'll sign in on the server's own site.
              </p>
            </template>
            <div class="api-key-actions">
              <UiButton @click="cancelMcpConnection">Cancel</UiButton>
              <UiButton type="submit" variant="primary">
                {{
                  mcpAuthMode === "oauth" ? "Continue to sign in" : "Add server"
                }}
              </UiButton>
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
  font-size: 0.85rem;
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

.mcp-status {
  display: grid;
  gap: 12px;
  margin: 0 8px;
  padding: 12px 0 4px;
  border-top: 1px solid var(--frock-border);
}

.mcp-server {
  display: grid;
  gap: 6px;
}

.mcp-server-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mcp-server-name {
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.mcp-state {
  padding: 1px 8px;
  border: 1px solid var(--frock-border);
  border-radius: 999px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.mcp-state-ready {
  color: var(--frock-text);
}

.mcp-state-error,
.mcp-state-needs-auth {
  border-color: var(--frock-danger-text);
  color: var(--frock-danger-text);
}

.mcp-meta,
.mcp-instructions {
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
