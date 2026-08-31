<script setup lang="ts">
import { UiButton, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref } from "vue";

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;
const search = ref("");
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

onMounted(() => web.value.loadPluginCatalog());

function isPackageInstalled(packageId: string): boolean {
  return Boolean(
    web.value.userSettings?.packages.some(
      (item) => item.packageId === packageId && item.state === "installed",
    ),
  );
}

function hasReadyConnection(
  packageId: string,
  connectionTypeId: string,
): boolean {
  return Boolean(
    web.value.userSettings?.connections.some(
      (connection) =>
        connection.packageId === packageId &&
        connection.connectionTypeId === connectionTypeId &&
        connection.state === "ready",
    ),
  );
}

async function install(packageId: string, version: string): Promise<void> {
  try {
    await web?.value.installPackage(packageId, version);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add Plugin";
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
        <div class="plugin-logo" aria-hidden="true">
          {{ item.displayName.slice(0, 1) }}
        </div>
        <div class="plugin-card-copy">
          <strong>{{ item.displayName }}</strong>
          <small>
            {{
              item.connectionTypes
                .map((connection) => connection.displayName)
                .join(", ")
            }}
          </small>
        </div>
        <span
          v-if="
            hasReadyConnection(
              item.packageId,
              item.connectionTypes[0]?.id ?? '',
            ) && !item.connectionTypes[0]?.allowMultiple
          "
          class="plugin-connected"
        >
          ✓ Connected
        </span>
        <UiButton
          v-else-if="isPackageInstalled(item.packageId)"
          @click="connect(item.packageId, item.connectionTypes[0]?.id ?? '')"
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
      </article>
    </div>

    <section
      v-if="web.userSettings?.connections.length"
      class="connected-accounts"
    >
      <h3>Connected accounts</h3>
      <article
        v-for="connection in web.userSettings.connections"
        :key="connection.connectionId"
        class="connected-account"
      >
        <div>
          <strong>{{ connection.displayName }}</strong>
          <small>{{ connection.state }}</small>
        </div>
        <UiButton
          v-if="
            connection.state !== 'revoked' && connection.state !== 'revoking'
          "
          variant="danger"
          @click="revoke(connection.packageId, connection.connectionId)"
        >
          Revoke
        </UiButton>
      </article>
    </section>

    <p
      v-if="web.pluginCatalog.length === 0 && !web.settingsError"
      class="plugin-empty"
    >
      No connection Packages are available.
    </p>
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
  display: grid;
  min-width: 0;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
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

.plugin-connected {
  color: var(--frock-success);
  font-size: var(--frock-text-sm);
  font-weight: 700;
}

.connected-accounts {
  margin-top: 28px;
}

.connected-accounts h3 {
  font-family: var(--frock-font-display);
  font-size: var(--frock-text-lg);
}

.connected-account {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-top: 1px solid var(--frock-border);
}

.connected-account strong,
.connected-account small {
  display: block;
}

.connected-account small {
  margin-top: 3px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  text-transform: capitalize;
}

.settings-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
