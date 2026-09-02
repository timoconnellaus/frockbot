<script setup lang="ts">
import { catalogSetupFieldKeyV1 } from "@frockbot/catalog-core";
import { UiButton, UiIcon } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb)
  throw new Error("Package Catalog client data was not provided");
const web = providedWeb;

const search = ref("");
const openCatalogId = ref<string>();
const openCatalogEntry = ref<CatalogEntryV1>();
const catalogEntryLoading = ref(false);
const uninstallingPackageId = ref<string>();
const setupValues = ref<Record<string, string>>({});
const setupValuesFor = ref<string>();
const installingCatalogId = ref<string>();

const filteredCatalog = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return web.value.packageCatalog;
  return web.value.packageCatalog.filter(
    (entry) =>
      entry.displayName.toLocaleLowerCase().includes(query) ||
      entry.packageId.toLocaleLowerCase().includes(query) ||
      entry.description.toLocaleLowerCase().includes(query) ||
      (entry.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(query)),
  );
});

onMounted(() => void web.value.loadPackageCatalog());

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

function entryUsesOAuth(entry: CatalogEntryV1 | undefined): boolean {
  return (entry?.servers ?? []).some((server) => server.auth === "oauth");
}

function beginSetup(entry: CatalogEntryV1): void {
  setupValuesFor.value = entry.catalogId;
  setupValues.value = Object.fromEntries(
    setupFieldsOf(entry).map((field) => [field.key, ""]),
  );
}

async function connectCatalogServer(label: string, url: string): Promise<void> {
  const redirect = await web.value.startMcpAuthorization({
    label,
    settings: { url, transport: "streamable-http" },
  });
  if (redirect) await web.value.openConnectionAuthorization(redirect);
}

async function installWithSetupValues(
  index: CatalogIndexEntryV1,
  entry: CatalogEntryV1,
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
    const server = (entry.servers ?? []).find(
      (candidate) => candidate.auth === "oauth",
    );
    if (server) await connectCatalogServer(entry.displayName, server.url);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not install the Package";
  } finally {
    installingCatalogId.value = undefined;
  }
}

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
    if (openCatalogId.value === entry.catalogId)
      openCatalogEntry.value = detail;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not load the entry";
  } finally {
    catalogEntryLoading.value = false;
  }
}

async function install(entry: CatalogIndexEntryV1): Promise<void> {
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
    if (openCatalogEntry.value?.packageId === packageId) {
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
</script>

<template>
  <div class="package-catalog-surface">
    <p class="catalog-intro">
      Browse published Packages. Installing one makes it available to every Bot
      you own; each Bot still needs an explicit Assignment to use it.
    </p>
    <label class="catalog-search">
      <UiIcon name="search" />
      <input
        v-model="search"
        placeholder="Search the Catalog"
        aria-label="Search the Package Catalog"
      />
    </label>
    <p v-if="web.packageCatalogGeneration" class="catalog-generation">
      Generation {{ web.packageCatalogGeneration }}
    </p>
    <div class="catalog-grid">
      <article
        v-for="entry in filteredCatalog"
        :key="entry.catalogId"
        class="catalog-card"
      >
        <button
          type="button"
          class="catalog-summary"
          :aria-expanded="openCatalogId === entry.catalogId"
          :aria-controls="`catalog-detail-${entry.catalogId}`"
          @click="toggleCatalogEntry(entry)"
        >
          <span class="catalog-logo" aria-hidden="true">
            {{ entry.displayName.slice(0, 1) }}
          </span>
          <span class="catalog-copy">
            <strong>{{ entry.displayName }}</strong>
            <small>{{ entry.description }}</small>
          </span>
          <span class="catalog-version">{{ entry.version }}</span>
          <UiIcon
            class="catalog-chevron"
            :class="{
              'catalog-chevron--open': openCatalogId === entry.catalogId,
            }"
            name="chevrons-right"
            size="sm"
          />
        </button>
        <div
          :id="`catalog-detail-${entry.catalogId}`"
          class="catalog-collapse"
          :class="{
            'catalog-collapse--open': openCatalogId === entry.catalogId,
          }"
          :inert="openCatalogId === entry.catalogId ? undefined : true"
        >
          <div class="catalog-collapse-inner">
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
                  Bot. Its Assignments stay visible as unavailable so you can
                  repair or remove them. Connections and credentials are kept.
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
                @submit.prevent="
                  installWithSetupValues(entry, openCatalogEntry)
                "
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
                <p v-if="entryUsesOAuth(openCatalogEntry)" class="catalog-hint">
                  After installing, you will be sent to the connector to sign
                  in. FrockBot records the request; only you can complete it.
                </p>
                <div class="catalog-actions">
                  <UiButton @click="setupValuesFor = undefined"
                    >Cancel</UiButton
                  >
                  <UiButton
                    type="submit"
                    variant="primary"
                    :disabled="installingCatalogId === entry.catalogId"
                  >
                    {{
                      installingCatalogId === entry.catalogId
                        ? "Installing…"
                        : "Install and connect"
                    }}
                  </UiButton>
                </div>
              </form>
              <div v-else class="catalog-actions">
                <UiButton
                  v-if="isPackageInstalled(entry.packageId)"
                  variant="danger"
                  @click="uninstallingPackageId = entry.packageId"
                >
                  Uninstall
                </UiButton>
                <UiButton
                  v-else-if="
                    openCatalogEntry &&
                    (setupFieldsOf(openCatalogEntry).length > 0 ||
                      entryUsesOAuth(openCatalogEntry))
                  "
                  variant="primary"
                  @click="beginSetup(openCatalogEntry)"
                >
                  Set up
                </UiButton>
                <UiButton v-else variant="primary" @click="install(entry)">
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
      class="catalog-empty"
    >
      The Catalog has nothing to offer yet.
    </p>
    <p v-else-if="filteredCatalog.length === 0" class="catalog-empty">
      No Catalog entry matches that search.
    </p>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
  </div>
</template>

<style scoped>
.package-catalog-surface {
  padding: 24px;
}

.catalog-intro,
.catalog-empty {
  margin: 0 0 14px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
}

.catalog-search {
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

.catalog-search:focus-within {
  border-color: var(--frock-border-focus);
  box-shadow: 0 0 0 3px var(--frock-focus-ring);
}

.catalog-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: var(--frock-text);
  background: transparent;
}

.catalog-generation {
  margin: 10px 0 0;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.catalog-grid {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.catalog-card {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
}

.catalog-summary {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border: 0;
  border-radius: var(--frock-radius-control);
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.catalog-summary:hover {
  background: var(--frock-fill-hover);
}

.catalog-logo {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 12px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-weight: 800;
}

.catalog-copy {
  min-width: 0;
}

.catalog-copy strong,
.catalog-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.catalog-copy strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.catalog-copy small,
.catalog-version,
.catalog-note,
.catalog-hint {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.catalog-copy small {
  margin-top: 4px;
}

.catalog-version {
  white-space: nowrap;
}

.catalog-chevron {
  color: var(--frock-text-subtle);
  transition: transform var(--frock-motion-panel);
}

.catalog-chevron--open {
  transform: rotate(90deg);
}

.catalog-collapse {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--frock-motion-panel),
    opacity var(--frock-motion-panel);
}

.catalog-collapse--open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.catalog-collapse-inner {
  min-height: 0;
  overflow: hidden;
}

.catalog-detail {
  display: grid;
  gap: 12px;
  padding: 12px 8px;
  border-top: 1px solid var(--frock-border);
}

.catalog-note,
.catalog-hint {
  margin: 0;
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

.catalog-form label > span:first-child {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.catalog-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  color: var(--frock-text);
  background: var(--frock-surface-raised);
  font-size: var(--frock-text-base);
}

.catalog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.catalog-empty {
  margin-top: 18px;
}

.settings-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
