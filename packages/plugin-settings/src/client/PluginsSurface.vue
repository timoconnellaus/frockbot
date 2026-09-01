<script setup lang="ts">
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import type { ConnectionView } from "@frockbot/configuration-core";
import type {
  PackageSettingDefinition,
  PackageSettingSchema,
} from "@frockbot/kernel-composition";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";

const providedWeb = inject(frockBotWebDataKey);
const providedSurfaces = inject(clientSurfaceRegistryKey);
if (!providedWeb || !providedSurfaces)
  throw new Error("Plugins client data was not provided");
const web = providedWeb;
const surfaces = providedSurfaces;
// Packages are User-scoped, so the catalog's link names no Bot.
const packagesLink = settingsLinkV1({ anchor: "user-packages" });
const defaultModelLink = settingsLinkV1({ anchor: "user-default-model" });
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
 * The connect cards. Drawn from the Connection projection — which carries no
 * URL — so a card can be shown by anything that can read Connections,
 * including a transcript replayed months later, while the redirect is authored
 * only when the User presses *Reconnect*.
 */
const pendingAuthorizations = computed(() =>
  (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.pendingAuthorization !== undefined &&
      connection.state !== "revoked",
  ),
);
const reconnectingConnectionId = ref<string>();

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
/**
 * The endpoint root of an Ollama Cloud Connection, declared by that Connection
 * Type as `api-base-url` (manifest v4). It is the only Connection Type the
 * shared API-key form has a field for, the way the MCP form above carries the
 * two settings its own Connection Types declare.
 */
const OLLAMA_PACKAGE_ID = "provider-ollama-cloud";
const apiKeyBaseUrl = ref("");

/**
 * The MCP lifecycle panel: the durable server records the User Durable Object
 * owns, which the Connection rows cannot show — a server's `needs-auth` or
 * `error` state, when it last handshook, what its instructions are, and the
 * refusals this build recorded rather than performed.
 */
const editingInstructionsFor = ref<string>();
const instructionsDraft = ref("");
const restartingServerId = ref<string>();
const mcpServers = computed(() => web.value.mcpServers?.servers ?? []);
const mcpRefusals = computed(() => web.value.mcpServers?.refusals ?? []);

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
const rotatingConnectionId = ref<string>();
const rotationKey = ref("");
const labelingConnectionId = ref<string>();
const connectionLabel = ref("");
const CONNECTABLE_ORDER = new Map([
  ["provider-ollama-cloud", 0],
  ["mcp", 1],
  ["telegram", 2],
]);

function pluginOrder(
  left: PluginCatalogItem,
  right: PluginCatalogItem,
): number {
  const leftConnectable = left.connectionTypes.length > 0;
  const rightConnectable = right.connectionTypes.length > 0;
  if (leftConnectable !== rightConnectable) return leftConnectable ? -1 : 1;
  if (leftConnectable) {
    const priority =
      (CONNECTABLE_ORDER.get(left.packageId) ?? Number.MAX_SAFE_INTEGER) -
      (CONNECTABLE_ORDER.get(right.packageId) ?? Number.MAX_SAFE_INTEGER);
    if (priority !== 0) return priority;
  }
  return left.displayName.localeCompare(right.displayName);
}

const filteredCatalog = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return web.value.pluginCatalog
    .filter(
      (item) =>
        !query ||
        item.displayName.toLocaleLowerCase().includes(query) ||
        item.connectionTypes.some((connection) =>
          connection.displayName.toLocaleLowerCase().includes(query),
        ),
    )
    .toSorted(pluginOrder);
});

const installedPluginCount = computed(
  () =>
    web.value.pluginCatalog.filter((item) => isPackageInstalled(item.packageId))
      .length,
);

function openPackageCatalog(): void {
  surfaces.open("package-catalog");
}

onMounted(() => {
  void web.value.loadPluginCatalog();
  void web.value.loadMcpServers();
});

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

function canBeginConnect(item: PluginCatalogItem): boolean {
  return primaryConnectionType(item)?.authorizationKind !== "ambient-native";
}

function defaultModelName(connection: ConnectionView): string | undefined {
  const selected = web.value.userSettings?.newBotModelTemplate;
  if (selected?.connectionId !== connection.connectionId) return undefined;
  return (
    connection.modelCatalog?.models.find(
      (model) => model.providerModelId === selected.providerModelId,
    )?.displayName ?? selected.providerModelId
  );
}

/**
 * The Package-level settings form.
 *
 * The fields are generated from the schema each Package declares, so a
 * Package that adds a setting gets a control here with no edit to this file:
 * the manifest is the only description of the knob that exists.
 */
const settingsPackageId = ref<string>();
const settingsDraft = ref<Record<string, string | number | boolean>>({});

/** How one declared setting is rendered. */
type SettingFieldKind = "enum" | "boolean" | "number" | "text";

function settingFieldKind(schema: PackageSettingSchema): SettingFieldKind {
  if (schema.enum && schema.enum.length > 0) return "enum";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "text";
}

function settingLabel(definition: PackageSettingDefinition): string {
  return definition.schema.title ?? definition.id;
}

/** The stored values of one installed Package, as the User settings hold them. */
function storedPackageSettings(packageId: string): Record<string, unknown> {
  const installation = web.value.userSettings?.packages.find(
    (candidate) => candidate.packageId === packageId,
  );
  return (installation?.values ?? {}) as Record<string, unknown>;
}

/** A draft seeded from durable state, so an untouched field saves unchanged. */
function beginPackageSettings(item: PluginCatalogItem): void {
  if (settingsPackageId.value === item.packageId) {
    settingsPackageId.value = undefined;
    return;
  }
  const stored = storedPackageSettings(item.packageId);
  const draft: Record<string, string | number | boolean> = {};
  for (const definition of item.settings ?? []) {
    const value = stored[definition.id];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      draft[definition.id] = value;
      continue;
    }
    draft[definition.id] =
      settingFieldKind(definition.schema) === "boolean" ? false : "";
  }
  settingsDraft.value = draft;
  settingsPackageId.value = item.packageId;
}

function cancelPackageSettings(): void {
  settingsPackageId.value = undefined;
  settingsDraft.value = {};
}

/**
 * Only the fields the User filled in are sent: the command is a partial
 * update, and an empty text or number box means "leave this one alone" rather
 * than "store an empty string".
 */
async function savePackageSettings(item: PluginCatalogItem): Promise<void> {
  const values: Record<string, string | number | boolean> = {};
  for (const definition of item.settings ?? []) {
    const kind = settingFieldKind(definition.schema);
    const raw = settingsDraft.value[definition.id];
    if (kind === "boolean") {
      values[definition.id] = raw === true;
      continue;
    }
    if (raw === "" || raw === undefined) continue;
    if (kind === "number") {
      const parsed = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(parsed)) continue;
      values[definition.id] = parsed;
      continue;
    }
    values[definition.id] = String(raw);
  }
  if (Object.keys(values).length === 0) {
    cancelPackageSettings();
    return;
  }
  try {
    await web.value.savePackageSettings(item.packageId, values);
    cancelPackageSettings();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : "Could not save the Package settings";
  }
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
  apiKeyBaseUrl.value = "";
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
      expandedPackageId.value = undefined;
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
    expandedPackageId.value = undefined;
  } catch (error) {
    mcpApiKey.value = "";
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add the MCP server";
  }
}

/** Start whichever authorization the card's Connection type declares. */
function beginConnect(item: PluginCatalogItem): void {
  const connectionType = primaryConnectionType(item);
  if (!connectionType) {
    web.value.settingsError = `${item.displayName} does not declare a Connection Type.`;
    return;
  }
  if (item.packageId === MCP_PACKAGE_ID) {
    beginMcpConnection();
    return;
  }
  if (connectionType.authorizationKind === "api-key") {
    beginApiKeyConnection(item.packageId, connectionType.id, item.displayName);
    return;
  }
  void connect(item.packageId, connectionType.id);
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
    apiKey.value = "";
    apiKeyBaseUrl.value = "";
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
  apiKeyBaseUrl.value = "";
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
    <div class="installed-strip" aria-live="polite">
      <span class="plugin-status-badge" aria-hidden="true">
        <UiIcon name="check" :size="12" :weight="2.5" />
      </span>
      {{ installedPluginCount }} installed
    </div>
    <label class="plugin-search">
      <UiIcon name="search" />
      <input
        v-model="search"
        placeholder="Search Plugins"
        aria-label="Search Plugins"
      />
    </label>
    <UiAnchor
      anchor="user-packages"
      label="Packages"
      :href="packagesLink"
      class="plugin-anchor"
    >
      <p class="plugin-intro">
        Add secure connections and capabilities to your Bots.
      </p>
    </UiAnchor>
    <section
      v-if="pendingAuthorizations.length"
      class="connect-cards"
      aria-label="Connections that need your authorization"
    >
      <article
        v-for="connection in pendingAuthorizations"
        :key="connection.connectionId"
        class="connect-card"
      >
        <div class="connect-card-copy">
          <strong>{{ connection.pendingAuthorization?.label }}</strong>
          <span>
            Needs your authorization. Only you can complete it — FrockBot
            creates the sign-in link when you press Reconnect, and nothing is
            stored waiting for it.
          </span>
        </div>
        <UiButton
          variant="primary"
          :disabled="reconnectingConnectionId === connection.connectionId"
          @click="reconnect(connection.connectionId)"
        >
          {{
            reconnectingConnectionId === connection.connectionId
              ? "Opening…"
              : "Reconnect"
          }}
        </UiButton>
      </article>
    </section>
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
                item.connectionTypes.length > 0
                  ? item.connectionTypes
                      .map((connection) => connection.displayName)
                      .join(", ")
                  : item.capabilities
                      .map((capability) => capability.id)
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
                item.connectionTypes.length > 0
                  ? item.connectionTypes
                      .map((connection) => connection.displayName)
                      .join(", ")
                  : item.capabilities
                      .map((capability) => capability.id)
                      .join(", ")
              }}
            </small>
          </span>
          <span
            v-if="
              isPackageInstalled(item.packageId) &&
              item.connectionTypes.length === 0
            "
            class="plugin-status plugin-status--ready"
          >
            <span class="plugin-status-badge" aria-hidden="true">
              <UiIcon name="check" :size="12" :weight="2.5" />
            </span>
            Added
          </span>
          <span v-else class="plugin-summary-actions">
            <UiButton
              v-if="
                isPackageInstalled(item.packageId) &&
                (item.settings ?? []).length > 0
              "
              @click="beginPackageSettings(item)"
            >
              Settings
            </UiButton>
            <UiButton
              v-if="isPackageInstalled(item.packageId) && canBeginConnect(item)"
              @click="beginConnect(item)"
            >
              Connect
            </UiButton>
            <span
              v-else-if="isPackageInstalled(item.packageId)"
              class="plugin-status plugin-status--ready"
            >
              <span class="plugin-status-badge" aria-hidden="true">
                <UiIcon name="check" :size="12" :weight="2.5" />
              </span>
              Added
            </span>
            <UiButton
              v-else
              variant="primary"
              @click="install(item.packageId, item.version)"
            >
              Add
            </UiButton>
          </span>
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
                <template
                  v-if="connection.authorization?.kind !== 'ambient-native'"
                >
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
                    @click="
                      revoke(connection.packageId, connection.connectionId)
                    "
                  >
                    Revoke
                  </UiButton>
                </template>
              </div>
              <p v-if="defaultModelName(connection)" class="account-default">
                Default model: {{ defaultModelName(connection) }}
                <a :href="defaultModelLink">Change</a>
              </p>
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

        <div
          v-if="
            item.packageId === MCP_PACKAGE_ID &&
            (mcpServers.length > 0 || mcpRefusals.length > 0)
          "
          class="mcp-status"
        >
          <div
            v-for="server in mcpServers"
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
              {{ server.toolCount }} tools · epoch {{ server.serverEpoch }} ·
              last handshake {{ handshakeLabel(server.lastHandshakeAt) }}
            </p>
            <p v-if="server.failure" class="connection-failure">
              {{ server.failure.code }}: {{ server.failure.message }}
            </p>
            <p v-if="server.instructions" class="mcp-instructions">
              {{ server.instructions }}
            </p>
            <div class="account-actions">
              <UiButton
                @click="
                  beginInstructions(server.serverId, server.instructions ?? '')
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
            {{ refusal.code }}: {{ refusal.message }}
          </p>
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
              <input v-model="mcpClientId" maxlength="512" autocomplete="off" />
            </label>
            <p class="api-key-hint">
              Leave both empty for a server that registers clients itself, which
              is what most do. FrockBot registers as a public client; a server
              that issues a client secret is refused, because a secret would
              have to live in this Connection's settings. You will be sent to
              the server to sign in, and no token ever reaches this page.
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
          <label v-if="apiKeyPackageId === OLLAMA_PACKAGE_ID">
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
          <p v-if="apiKeyPackageId === OLLAMA_PACKAGE_ID" class="api-key-hint">
            Leave empty for Ollama Cloud. Point this at a local Ollama server
            (http://127.0.0.1:11434) or any Ollama-compatible endpoint.
          </p>
          <div class="api-key-actions">
            <UiButton @click="cancelApiKeyConnection">Cancel</UiButton>
            <UiButton type="submit" variant="primary">Connect account</UiButton>
          </div>
        </form>

        <form
          v-if="settingsPackageId === item.packageId"
          class="api-key-form"
          @submit.prevent="savePackageSettings(item)"
        >
          <label v-for="definition in item.settings ?? []" :key="definition.id">
            <span>{{ settingLabel(definition) }}</span>
            <select
              v-if="settingFieldKind(definition.schema) === 'enum'"
              v-model="settingsDraft[definition.id]"
            >
              <option value="">Package default</option>
              <option
                v-for="choice in definition.schema.enum ?? []"
                :key="String(choice)"
                :value="choice ?? ''"
              >
                {{ String(choice) }}
              </option>
            </select>
            <input
              v-else-if="settingFieldKind(definition.schema) === 'boolean'"
              v-model="settingsDraft[definition.id]"
              type="checkbox"
            />
            <input
              v-else-if="settingFieldKind(definition.schema) === 'number'"
              v-model="settingsDraft[definition.id]"
              type="number"
              inputmode="numeric"
              :min="definition.schema.minimum"
              :max="definition.schema.maximum"
              :step="definition.schema.type === 'integer' ? 1 : 'any'"
            />
            <input
              v-else
              v-model="settingsDraft[definition.id]"
              type="text"
              :maxlength="definition.schema.maxLength"
            />
            <small v-if="definition.schema.description" class="api-key-hint">
              {{ definition.schema.description }}
            </small>
          </label>
          <div class="api-key-actions">
            <UiButton @click="cancelPackageSettings">Cancel</UiButton>
            <UiButton type="submit" variant="primary">Save settings</UiButton>
          </div>
        </form>
      </article>
    </div>

    <p
      v-if="web.pluginCatalog.length === 0 && !web.settingsError"
      class="plugin-empty"
    >
      No Plugins are available.
    </p>

    <button type="button" class="catalog-link" @click="openPackageCatalog">
      Browse the Package Catalog →
    </button>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
  </div>
</template>

<style scoped>
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
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 0.75rem 1rem;
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

.plugin-anchor {
  padding-right: var(--frock-control-sm);
}

.plugins-surface {
  padding: 24px;
}

.installed-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 600;
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

.plugin-summary-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
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

.account-default {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.account-default a {
  margin-left: 4px;
  color: var(--frock-action-primary);
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
  font-size: var(--frock-text-base);
  color: var(--frock-text);
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
  color: var(--frock-danger-text);
  border-color: var(--frock-danger-text);
}

.api-key-hint,
.mcp-meta,
.mcp-instructions {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.api-key-form textarea {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
  font-family: inherit;
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
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.catalog-link {
  display: block;
  margin: 20px auto 0;
  padding: 4px;
  border: 0;
  color: var(--frock-action-secondary-text);
  background: transparent;
  font: inherit;
  font-size: var(--frock-text-sm);
  cursor: pointer;
}

.catalog-link:hover {
  text-decoration: underline;
}
</style>
