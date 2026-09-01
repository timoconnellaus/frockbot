<script setup lang="ts">
/**
 * Plugins: what a User has, and whether it is on.
 *
 * Enablement only. Nothing a Package declares — its accounts, its credentials,
 * its settings — is edited here: each of those lives on the surface that owns
 * what it configures, and this surface links to it. A disabled Package keeps
 * all of it and simply stops being available to any Bot.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { catalogSetupFieldKeyV1 } from "@frockbot/catalog-core";
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
// Packages are User-scoped, so the catalog's link names no Bot.
const packagesLink = settingsLinkV1({ anchor: "user-packages" });
const search = ref("");
const busyPackageId = ref<string>();

const installations = computed(() => web.value.userSettings?.packages ?? []);
const filteredCatalog = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return web.value.pluginCatalog;
  return web.value.pluginCatalog.filter(
    (item) =>
      item.displayName.toLocaleLowerCase().includes(query) ||
      item.packageId.toLocaleLowerCase().includes(query),
  );
});

const catalogSearch = ref("");
const openCatalogId = ref<string>();
const openCatalogEntry = ref<CatalogEntryV1>();
const catalogEntryLoading = ref(false);
const uninstallingPackageId = ref<string>();
const installingCatalogId = ref<string>();
/**
 * Guided install: the `setupFields` an entry declares, as the User fills them
 * in. Keyed by entry so opening a second entry does not inherit the first
 * one's answers.
 */
const setupValues = ref<Record<string, string>>({});
const setupValuesFor = ref<string>();
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

/** What a Package offers, in the words its manifest uses. */
function capabilitySummary(item: PluginCatalogItem): string {
  const kinds = [...new Set(item.capabilities.map((entry) => entry.kind))];
  if (kinds.length === 0) return "No Capabilities";
  return kinds.join(", ");
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

async function install(item: PluginCatalogItem): Promise<void> {
  busyPackageId.value = item.packageId;
  try {
    await web.value.installPackage(item.packageId, item.version);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add the Package";
  } finally {
    busyPackageId.value = undefined;
  }
}

async function setEnabled(packageId: string, next: boolean): Promise<void> {
  busyPackageId.value = packageId;
  try {
    await web.value.setPackageEnabled(packageId, next);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : "Could not change the Package state";
  } finally {
    busyPackageId.value = undefined;
  }
}

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

/**
 * The entry's setup fields, paired with the `values` key each answer is
 * recorded under. A Catalog setup field is a bare JSON Schema with no
 * identifier, so the key is derived — in `catalog-core`, so the form and
 * anything that reads the install back agree on it.
 */
function setupFieldsOf(entry: CatalogEntryV1 | undefined): Array<{
  key: string;
  title: string;
  description?: string;
  maxLength?: number;
}> {
  return (entry?.setupFields ?? []).map((field, index) => ({
    key: catalogSetupFieldKeyV1(field, index),
    title: field.title ?? catalogSetupFieldKeyV1(field, index),
    ...(field.description ? { description: field.description } : {}),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
  }));
}

function beginSetup(entry: CatalogEntryV1): void {
  setupValuesFor.value = entry.catalogId;
  setupValues.value = Object.fromEntries(
    setupFieldsOf(entry).map((field) => [field.key, ""]),
  );
}

async function installFromCatalog(entry: CatalogIndexEntryV1): Promise<void> {
  try {
    await web.value.installCatalogPackage(entry);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not install the Package";
  }
}

/**
 * Install with the values the form collected. Authorizing the connector it
 * brings is Connections' job, and the row below says so rather than starting
 * an authorization from the surface that only installs things.
 */
async function installWithSetupValues(
  index: CatalogIndexEntryV1,
): Promise<void> {
  installingCatalogId.value = index.catalogId;
  try {
    const values = Object.fromEntries(
      Object.entries(setupValues.value)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value.length > 0),
    );
    await web.value.installCatalogPackage(index, values);
    setupValuesFor.value = undefined;
    setupValues.value = {};
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not install the Package";
  } finally {
    installingCatalogId.value = undefined;
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
    <UiAnchor
      anchor="user-packages"
      label="Packages"
      :href="packagesLink"
      class="plugin-anchor"
    >
      <p class="plugin-intro">
        Turn Packages on and off for your Bots. Set one up where it belongs:
        model providers in Models, accounts in Connections.
      </p>
    </UiAnchor>
    <div class="plugin-grid">
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
        <p v-if="failure(item.packageId)" class="plugin-failure" role="alert">
          {{ failure(item.packageId) }}
        </p>
      </article>
    </div>

    <p
      v-if="web.pluginCatalog.length === 0 && !web.settingsError"
      class="plugin-empty"
    >
      This application ships no Packages.
    </p>
    <p v-else-if="filteredCatalog.length === 0" class="plugin-empty">
      No Package matches that search.
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
            class="catalog-panel"
            :class="{
              'catalog-panel--open': openCatalogId === entry.catalogId,
            }"
            :inert="openCatalogId === entry.catalogId ? undefined : true"
          >
            <div class="catalog-panel-inner">
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
                  <div class="catalog-actions">
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
                <form
                  v-else-if="
                    setupValuesFor === entry.catalogId && openCatalogEntry
                  "
                  class="catalog-form"
                  @submit.prevent="installWithSetupValues(entry)"
                >
                  <label
                    v-for="field in setupFieldsOf(openCatalogEntry)"
                    :key="field.key"
                  >
                    <span>{{ field.title }}</span>
                    <input
                      v-model="setupValues[field.key]"
                      autocomplete="off"
                      :maxlength="field.maxLength ?? 2048"
                    />
                    <span v-if="field.description" class="catalog-hint">
                      {{ field.description }}
                    </span>
                  </label>
                  <p class="catalog-hint">
                    Installing makes this Package available. Connect the account
                    it needs in Connections afterwards.
                  </p>
                  <div class="catalog-actions">
                    <UiButton @click="setupValuesFor = undefined">
                      Cancel
                    </UiButton>
                    <UiButton
                      type="submit"
                      variant="primary"
                      :disabled="installingCatalogId === entry.catalogId"
                    >
                      {{
                        installingCatalogId === entry.catalogId
                          ? "Installing…"
                          : "Install"
                      }}
                    </UiButton>
                  </div>
                </form>
                <div v-else class="catalog-actions">
                  <UiButton
                    v-if="installed(entry.packageId)"
                    variant="danger"
                    @click="uninstallingPackageId = entry.packageId"
                  >
                    Uninstall
                  </UiButton>
                  <UiButton
                    v-else-if="
                      openCatalogEntry &&
                      setupFieldsOf(openCatalogEntry).length > 0
                    "
                    variant="primary"
                    @click="beginSetup(openCatalogEntry)"
                  >
                    Set up
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
  grid-template-columns: 44px minmax(0, 1fr) auto auto;
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
  flex-wrap: wrap;
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

.plugin-chevron {
  color: var(--frock-text-subtle);
  transform: rotate(0deg);
  transition: transform var(--frock-motion-panel);
}

.plugin-chevron--open {
  transform: rotate(90deg);
}

.catalog-panel {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--frock-motion-panel),
    opacity var(--frock-motion-panel);
}

.catalog-panel--open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.catalog-panel-inner {
  min-height: 0;
  overflow: hidden;
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

.catalog-form {
  display: grid;
  gap: 12px;
}

.catalog-form label {
  display: grid;
  gap: 6px;
}

.catalog-form span {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.catalog-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.catalog-hint {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.catalog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.settings-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
