<script setup lang="ts">
/**
 * The accounts of one Package: every Connection it owns and the actions each
 * one offers.
 *
 * Shared by Models and Connections, which differ in what they add around it —
 * a provider catalog and a model choice on one, an authorization handoff on
 * the other — and not in how an account is renamed, rotated, disabled, or
 * disconnected.
 */
import { UiButton } from "@frockbot/client-ui";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, ref } from "vue";

const props = defineProps<{ item: PluginCatalogItem }>();

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;

const rotatingConnectionId = ref<string>();
const rotationKey = ref("");
const labelingConnectionId = ref<string>();
const connectionLabel = ref("");

/**
 * The accounts this card speaks for. A revoked Connection is a tombstone the
 * User has already dismissed, so it is not listed.
 */
const connections = computed<ConnectionView[]>(() =>
  (web.value.userSettings?.connections ?? []).filter(
    (connection) =>
      connection.packageId === props.item.packageId &&
      connection.state !== "revoked",
  ),
);

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

type StatusTone = "ready" | "muted" | "attention";

function connectionTone(connection: ConnectionView): StatusTone {
  if (connection.state === "ready") return "ready";
  if (connection.state === "failed") return "attention";
  if (connection.state === "reconciliation-required") return "attention";
  return "muted";
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

async function revoke(packageId: string, connectionId: string): Promise<void> {
  try {
    await web.value.revokeConnection(packageId, connectionId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not revoke Connection";
  }
}
</script>

<template>
  <div class="package-accounts">
    <div
      v-for="connection in connections"
      :key="connection.connectionId"
      class="package-account"
    >
      <div class="account-identity">
        <span
          class="account-dot"
          :class="`account-dot--${connectionTone(connection)}`"
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
  </div>
</template>

<style scoped>
.package-account {
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

.inline-form input {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.connection-failure {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
