<script setup lang="ts">
/**
 * Plugins: what a User has, and whether it is on.
 *
 * Enablement only. Nothing a Package declares — its accounts, its credentials,
 * its settings — is edited here: each of those lives on the surface that owns
 * what it configures, and this surface links to it. A disabled Package keeps
 * all of it and simply stops being available to any Bot. Installing something
 * new is the Package Catalog, one surface over.
 */
import {
  classifyClientFailureV1,
  clientSurfaceRegistryKey,
  presentClientFailureV1,
} from "@frockbot/client-core";
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import {
  configurationHomeLabel,
  isPackageEnabled,
  isPackageInstalled,
  packageConfigurationHome,
  type PackageConfigurationHome,
} from "./package-surfaces.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
// Packages are User-scoped, so the row's link names no Bot.
const packagesLink = settingsLinkV1({ anchor: "user-packages" });
const search = ref("");
const busyPackageId = ref<string>();

const installations = computed(() => web.value.userSettings?.packages ?? []);
const userPackages = computed(() =>
  web.value.pluginCatalog.filter((item) => !item.platformOwned),
);
const installedPluginCount = computed(
  () =>
    userPackages.value.filter((item) =>
      isPackageInstalled(installations.value, item.packageId),
    ).length,
);
const filteredCatalog = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return userPackages.value;
  return userPackages.value.filter(
    (item) =>
      item.displayName.toLocaleLowerCase().includes(query) ||
      item.packageId.toLocaleLowerCase().includes(query),
  );
});

onMounted(() => {
  void web.value.loadPluginCatalog();
});

/** Plain nouns for the manifest's capability kinds. */
const CAPABILITY_NOUNS: Record<string, string> = {
  tool: "Tools",
  model: "Models",
  memory: "Memory",
  notification: "Notifications",
  computer: "Computer",
  ui: "Pages",
  storage: "Storage",
};

function capabilityNoun(kind: string): string {
  return CAPABILITY_NOUNS[kind] ?? kind;
}

/** What a plugin offers, in plain words. */
function capabilitySummary(item: PluginCatalogItem): string {
  const kinds = [...new Set(item.capabilities.map((entry) => entry.kind))];
  // A plugin can be worth turning on without contributing a capability of its
  // own — Custom models is exactly that — so saying "no features" tells the
  // User the one plugin they must enable does nothing.
  if (kinds.length === 0) return "Adds settings";
  return kinds.map(capabilityNoun).join(", ");
}

function installed(packageId: string): boolean {
  return isPackageInstalled(installations.value, packageId);
}

function enabled(packageId: string): boolean {
  return isPackageEnabled(installations.value, packageId);
}

function failure(packageId: string): string | undefined {
  return installations.value.find(
    (candidate) => candidate.packageId === packageId,
  )?.failure;
}

function stateLabel(packageId: string): string {
  if (!installed(packageId)) return "Not installed";
  if (enabled(packageId)) return "Enabled";
  const installation = installations.value.find(
    (candidate) => candidate.packageId === packageId,
  );
  return installation?.state === "failed" ? "Failed" : "Disabled";
}

function home(item: PluginCatalogItem): PackageConfigurationHome {
  return packageConfigurationHome(item);
}

/** The surface that owns this Package's configuration, when it has one. */
function homeLabel(item: PluginCatalogItem): string | undefined {
  return enabled(item.packageId)
    ? configurationHomeLabel(home(item))
    : undefined;
}

function openHome(item: PluginCatalogItem): void {
  const target = home(item);
  if (target === "none") return;
  surfaces.open(target);
}

function openPackageCatalog(): void {
  surfaces.open("package-catalog");
}

/** The read the error banner offers again. */
async function reload(): Promise<void> {
  await web.value.loadPluginCatalog();
}

/**
 * Refusals live on the row that was clicked, not in one panel-wide slot.
 *
 * The grid scrolls, so a message rendered above the list is off-screen for
 * every row past the fold: the User sees the row unchanged and no explanation
 * anywhere.
 */
const rowErrors = ref<Record<string, string>>({});

function rowError(packageId: string): string | undefined {
  return rowErrors.value[packageId];
}

function setRowError(packageId: string, message: string): void {
  rowErrors.value = { ...rowErrors.value, [packageId]: message };
}

function clearRowError(packageId: string): void {
  const { [packageId]: _cleared, ...rest } = rowErrors.value;
  rowErrors.value = rest;
}

/**
 * Say what a Package is called, not what its id is.
 *
 * The backend refuses in terms of ids because that is what it holds; the
 * surface knows the display names, so it substitutes them before the User
 * reads the message.
 */
function inPlainNames(message: string): string {
  const dependency = message.match(
    /^Package "([^"]+)" requires Package "([^"]+)" to be installed and enabled/,
  );
  if (dependency) {
    return `${displayName(dependency[1]!)} needs ${displayName(
      dependency[2]!,
    )} turned on first.`;
  }
  return message.replace(/"([a-z0-9][a-z0-9-]*)"/g, (quoted, packageId) =>
    displayName(packageId) === packageId
      ? quoted
      : `"${displayName(packageId)}"`,
  );
}

function displayName(packageId: string): string {
  return (
    web.value.pluginCatalog.find(
      (candidate) => candidate.packageId === packageId,
    )?.displayName ?? packageId
  );
}

/**
 * What the row says about a click that did not work.
 *
 * A refusal is the deployment explaining an invariant it holds, in terms this
 * surface can turn into names — "X needs Y turned on first" — so its text is
 * worth reading. Everything else is a transport failure, whose text is about
 * this client's own plumbing and is never the User's to read: it becomes the
 * shared sentence and the detail goes to the console.
 */
function rowFailure(error: unknown, action: string): string {
  const classified = classifyClientFailureV1(error);
  console.debug("plugin action failed", classified.detail);
  return classified.serverMessage
    ? inPlainNames(classified.serverMessage)
    : presentClientFailureV1(error, action);
}

async function install(item: PluginCatalogItem): Promise<void> {
  busyPackageId.value = item.packageId;
  clearRowError(item.packageId);
  try {
    await web.value.installPackage(item.packageId, item.version);
  } catch (error) {
    setRowError(item.packageId, rowFailure(error, `add ${item.displayName}`));
  } finally {
    busyPackageId.value = undefined;
  }
}

async function setEnabled(packageId: string, next: boolean): Promise<void> {
  busyPackageId.value = packageId;
  clearRowError(packageId);
  try {
    await web.value.setPackageEnabled(packageId, next);
  } catch (error) {
    setRowError(
      packageId,
      rowFailure(error, next ? "turn that plugin on" : "turn that plugin off"),
    );
  } finally {
    busyPackageId.value = undefined;
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
    <!--
      A refused click belongs on its own row; this slot is for the read that
      draws the whole list. A failed read leaves the last-known list on screen
      — dimmed, because it is no longer confirmed — and offers the read again.
    -->
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
      <UiButton type="button" @click="reload">Retry</UiButton>
    </p>
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
      label="Plugins"
      :href="packagesLink"
      class="plugin-anchor"
    >
      <p class="plugin-intro">
        Turn plugins on and off for your Bots. Set one up where it belongs:
        model providers in Models, accounts in Connectors.
      </p>
      <div class="plugin-catalog-link">
        <UiButton type="button" @click="openPackageCatalog">
          Browse all plugins
        </UiButton>
      </div>
    </UiAnchor>
    <div
      class="plugin-grid"
      :class="{ 'plugin-grid--stale': Boolean(web.settingsError) }"
    >
      <article
        v-for="item in filteredCatalog"
        :key="item.packageId"
        class="plugin-card"
      >
        <div class="plugin-summary">
          <span class="plugin-logo" aria-hidden="true">
            {{ item.displayName.slice(0, 1) }}
          </span>
          <span class="plugin-card-copy">
            <strong>{{ item.displayName }}</strong>
            <small>{{ capabilitySummary(item) }}</small>
          </span>
          <span
            class="plugin-state"
            :class="{ 'plugin-state--on': enabled(item.packageId) }"
          >
            {{ stateLabel(item.packageId) }}
          </span>
          <span class="plugin-actions">
            <UiButton v-if="homeLabel(item)" @click="openHome(item)">
              Set up in {{ homeLabel(item) }}
            </UiButton>
            <UiButton
              v-if="!installed(item.packageId)"
              variant="primary"
              :disabled="busyPackageId === item.packageId"
              @click="install(item)"
            >
              Add
            </UiButton>
            <UiButton
              v-else-if="enabled(item.packageId)"
              :disabled="busyPackageId === item.packageId"
              @click="setEnabled(item.packageId, false)"
            >
              Disable
            </UiButton>
            <UiButton
              v-else
              variant="primary"
              :disabled="busyPackageId === item.packageId"
              @click="setEnabled(item.packageId, true)"
            >
              Enable
            </UiButton>
          </span>
        </div>
        <p v-if="rowError(item.packageId)" class="plugin-failure" role="alert">
          {{ rowError(item.packageId) }}
        </p>
        <p v-if="failure(item.packageId)" class="plugin-failure" role="alert">
          {{ failure(item.packageId) }}
        </p>
      </article>
    </div>

    <p
      v-if="userPackages.length === 0 && !web.settingsError"
      class="plugin-empty"
    >
      This deployment ships no plugins.
    </p>
    <p v-else-if="filteredCatalog.length === 0" class="plugin-empty">
      No plugin matches that search.
    </p>
  </div>
</template>

<style scoped>
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

.plugin-status-badge {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 999px;
  color: var(--frock-on-accent);
  background: var(--frock-success);
}

.plugin-anchor {
  padding-right: var(--frock-control-sm);
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

.plugin-catalog-link {
  margin-top: 12px;
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

/*
 * The name is the only thing in the row that identifies what a click will
 * change, so it is the one thing that may not be the first to shrink. A grid
 * gave the actions a min-content column and let the title collapse to an
 * ellipsis — on a phone, to nothing at all — so the row wraps instead: the
 * copy keeps a readable basis and the buttons drop to their own line when
 * they no longer fit beside it.
 */
.plugin-summary {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border: 0;
  border-radius: var(--frock-radius-control);
  color: inherit;
  background: transparent;
  text-align: left;
}

.plugin-logo {
  display: grid;
  flex: 0 0 auto;
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
  flex: 1 1 12rem;
}

.plugin-card-copy strong,
.plugin-card-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.plugin-card-copy strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.plugin-card-copy small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  text-transform: capitalize;
}

.plugin-state {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 700;
  white-space: nowrap;
}

.plugin-state--on {
  color: var(--frock-success);
}

.plugin-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  margin-left: auto;
  justify-content: flex-end;
  gap: 8px;
}

.plugin-actions :deep(.ui-button) {
  min-height: 28px;
  padding: 0 10px;
  font-size: var(--frock-text-sm);
}

.plugin-failure {
  margin: 0 8px 8px;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

/*
 * What is on screen after a failed read is the last thing known, not the
 * current thing. Dimming it says so, so a toggle is not made against a list
 * the deployment has just refused to confirm.
 */
.plugin-grid--stale {
  opacity: 0.55;
}
</style>
