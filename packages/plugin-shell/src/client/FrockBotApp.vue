<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type WebToolActivity,
} from "../shared.js";

const injectedWeb = inject(frockBotWebDataKey);
if (!injectedWeb) throw new Error("shell client data was not provided");
const web = injectedWeb;
const draft = ref("");
const rightPanelOpen = ref(true);
const settingsOpen = ref(false);
const pluginsOpen = ref(false);
const pluginSearch = ref("");
const profileMenuOpen = ref(false);
const userSettingsOpen = ref(false);
const userSettingsName = ref("");
const userSettingsEmail = ref("");
const settingsSaving = ref(false);
const settingsName = ref("");
const settingsLabel = ref("");
const settingsDescription = ref("");
const settingsNotifications = ref(false);
const state = computed(() => web.value);
const botName = computed(
  () => state.value.botSettings?.profile.name ?? "Barebones",
);
const filteredPluginCatalog = computed(() => {
  const query = pluginSearch.value.trim().toLocaleLowerCase();
  if (!query) return state.value.pluginCatalog;
  return state.value.pluginCatalog.filter(
    (item) =>
      item.displayName.toLocaleLowerCase().includes(query) ||
      item.connectionTypes.some((connection) =>
        connection.displayName.toLocaleLowerCase().includes(query),
      ),
  );
});
const isRunning = computed(() => Boolean(state.value.activeRunId));
const canSend = computed(
  () =>
    state.value.connection === "ready" &&
    !isRunning.value &&
    draft.value.trim().length > 0,
);

function toolSymbol(tool: WebToolActivity): string {
  if (tool.status === "running") return "···";
  if (tool.status === "failed") return "!";
  return "✓";
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || !canSend.value) return;
  draft.value = "";
  const result = await web.value.sendPrompt(text);
  if (!result.accepted) draft.value = text;
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void sendMessage();
}

function closeMenus(): void {
  profileMenuOpen.value = false;
}

async function openUserSettings(): Promise<void> {
  profileMenuOpen.value = false;
  userSettingsOpen.value = true;
  await web.value.loadUserSettings();
  const settings = web.value.userSettings;
  if (!settings) return;
  userSettingsName.value = settings.profile.name;
  userSettingsEmail.value = settings.profile.email ?? "";
}

async function saveUserSettings(): Promise<void> {
  settingsSaving.value = true;
  try {
    await web.value.saveUserProfile({
      name: userSettingsName.value,
      email: userSettingsEmail.value || undefined,
    });
    userSettingsOpen.value = false;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save settings";
  } finally {
    settingsSaving.value = false;
  }
}

async function openPlugins(): Promise<void> {
  pluginsOpen.value = true;
  await web.value.loadPluginCatalog();
}

function isPackageInstalled(packageId: string): boolean {
  return Boolean(
    state.value.userSettings?.packages.some(
      (pkg) => pkg.packageId === packageId && pkg.state === "installed",
    ),
  );
}

function hasReadyConnection(
  packageId: string,
  connectionTypeId: string,
): boolean {
  return Boolean(
    state.value.userSettings?.connections.some(
      (connection) =>
        connection.packageId === packageId &&
        connection.connectionTypeId === connectionTypeId &&
        connection.state === "ready",
    ),
  );
}

async function installPlugin(
  packageId: string,
  version: string,
): Promise<void> {
  try {
    await web.value.installPackage(packageId, version);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not add Plugin";
  }
}

async function connectPlugin(
  packageId: string,
  connectionTypeId: string,
): Promise<void> {
  try {
    const redirectUrl = await web.value.startConnection(
      packageId,
      connectionTypeId,
    );
    if (redirectUrl) await web.value.openConnectionAuthorization(redirectUrl);
    await web.value.loadPluginCatalog();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not start Connection";
  }
}

async function revokePluginConnection(
  packageId: string,
  connectionId: string,
): Promise<void> {
  try {
    await web.value.revokeConnection(packageId, connectionId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not revoke Connection";
  }
}

async function openSettings(): Promise<void> {
  settingsOpen.value = true;
  await web.value.loadBotSettings();
  const settings = web.value.botSettings;
  if (!settings) return;
  settingsName.value = settings.profile.name;
  settingsLabel.value = settings.profile.label ?? "";
  settingsDescription.value = settings.profile.description ?? "";
  settingsNotifications.value = settings.notifications.enabled;
}

async function saveSettings(): Promise<void> {
  settingsSaving.value = true;
  try {
    await web.value.saveBotProfile({
      name: settingsName.value,
      label: settingsLabel.value || undefined,
      description: settingsDescription.value || undefined,
    });
    await web.value.saveBotNotifications({
      enabled: settingsNotifications.value,
    });
    settingsOpen.value = false;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save settings";
  } finally {
    settingsSaving.value = false;
  }
}

onMounted(() => {
  window.addEventListener("pointerdown", closeMenus);
  if (state.value.settingsAvailable) void web.value.loadBotSettings();
});
onBeforeUnmount(() => window.removeEventListener("pointerdown", closeMenus));
</script>

<template>
  <div class="frockbot-root">
    <div class="app-shell" :class="{ 'panel-open': rightPanelOpen }">
      <aside class="sidebar">
        <div class="window-controls" aria-hidden="true" />
        <div class="bot-list">
          <div class="bot-row active">
            <span class="bot-icon">⌁</span>
            <span class="bot-copy">
              <strong>{{ botName }}</strong>
              <small>A plain bot, ready to grow.</small>
            </span>
            <time>Now</time>
          </div>
        </div>

        <div class="sidebar-bottom">
          <button
            v-if="state.connectionsAvailable"
            class="plugins"
            @click="openPlugins"
          >
            <span>⊙</span>Plugins
          </button>
          <div class="profile-area" @pointerdown.stop>
            <button
              class="profile"
              @click="
                state.settingsAvailable && (profileMenuOpen = !profileMenuOpen)
              "
            >
              <span class="profile-face" />
              {{ state.userSettings?.profile.name ?? "FrockBot user" }}
            </button>
            <div
              v-if="state.settingsAvailable && profileMenuOpen"
              class="profile-menu"
            >
              <button type="button" @click="openUserSettings">Settings</button>
            </div>
          </div>
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <span class="book-icon">⌁</span>
          <div class="workspace-title">
            <strong>{{ botName }}</strong>
            <small>{{ state.modelLabel }}</small>
          </div>
          <button
            v-if="state.settingsAvailable"
            class="icon-button"
            title="Bot settings"
            aria-label="Bot settings"
            @click="openSettings"
          >
            ⚙
          </button>
          <button
            class="panel-toggle"
            :title="
              rightPanelOpen ? 'Hide computer panel' : 'Show computer panel'
            "
            :aria-label="
              rightPanelOpen ? 'Hide computer panel' : 'Show computer panel'
            "
            @click="rightPanelOpen = !rightPanelOpen"
          >
            {{ rightPanelOpen ? "»" : "«" }}
          </button>
        </header>

        <section class="thread" aria-live="polite">
          <div v-if="state.messages.length === 0" class="empty-thread">
            <div class="empty-mark">⌁</div>
            <h1>{{ botName }} is ready.</h1>
            <p>Start with a conversation. Cordis plugins can add the rest.</p>
          </div>
          <article
            v-for="message in state.messages"
            v-else
            :key="message.id"
            class="message"
            :class="
              message.role === 'user' ? 'message-user' : 'message-assistant'
            "
          >
            <div class="message-bubble">
              <span v-if="message.text">{{ message.text }}</span>
              <span v-else class="typing" aria-label="Thinking"
                ><i /><i /><i
              /></span>
            </div>
            <div v-if="message.tools.length" class="tool-list">
              <details
                v-for="tool in message.tools"
                :key="tool.id"
                class="tool-row"
                :class="`tool-${tool.status}`"
              >
                <summary>
                  <span class="tool-symbol">{{ toolSymbol(tool) }}</span>
                  <span>{{ tool.name }}</span>
                </summary>
                <pre v-if="tool.text">{{ tool.text }}</pre>
              </details>
            </div>
          </article>
        </section>

        <div v-if="state.error" class="error-banner" role="alert">
          <span>{{ state.error }}</span>
          <button v-if="state.connection !== 'ready'" @click="web.restart()">
            Restart agent
          </button>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <textarea
            v-model="draft"
            :placeholder="
              state.connection === 'ready'
                ? `Message ${botName}`
                : 'Waiting for Cordis…'
            "
            :disabled="state.connection !== 'ready'"
            rows="1"
            @keydown="handleComposerKeydown"
          />
          <button
            v-if="isRunning"
            type="button"
            class="stop-button"
            @click="web.abort()"
          >
            Stop
          </button>
          <button
            v-else
            class="send-button"
            type="submit"
            :disabled="!canSend"
            aria-label="Send message"
          >
            ↑
          </button>
        </form>
      </main>

      <aside v-if="rightPanelOpen" class="right-panel">
        <k-slot name="frockbot.computer" />
        <section class="routines-section">
          <div class="panel-heading"><strong>Routines</strong></div>
          <div class="routine-empty">
            <span>○</span>
            <div>
              <strong>No routines yet</strong>
              <p>Ask Barebones to repeat something later.</p>
            </div>
          </div>
        </section>
        <k-slot name="frockbot.right-panel" />
      </aside>
    </div>

    <div
      v-if="pluginsOpen"
      class="settings-backdrop"
      role="presentation"
      @click.self="pluginsOpen = false"
    >
      <section
        class="settings-dialog plugins-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
      >
        <header class="settings-header">
          <span />
          <h2 id="plugins-title">Plugins</h2>
          <button aria-label="Close Plugins" @click="pluginsOpen = false">
            ×
          </button>
        </header>
        <div class="plugins-content">
          <label class="plugin-search">
            <span>⌕</span>
            <input
              v-model="pluginSearch"
              placeholder="Search Plugins"
              aria-label="Search Plugins"
            />
          </label>
          <p class="plugin-intro">
            Add secure connections and capabilities to your Bots.
          </p>
          <div class="plugin-grid">
            <article
              v-for="item in filteredPluginCatalog"
              :key="item.packageId"
              class="plugin-card"
            >
              <div class="plugin-logo">{{ item.displayName.slice(0, 1) }}</div>
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
                  )
                "
                class="plugin-added"
                >✓ Connected</span
              >
              <button
                v-else-if="isPackageInstalled(item.packageId)"
                type="button"
                @click="
                  connectPlugin(
                    item.packageId,
                    item.connectionTypes[0]?.id ?? '',
                  )
                "
              >
                Connect
              </button>
              <button
                v-else
                type="button"
                @click="installPlugin(item.packageId, item.version)"
              >
                Add
              </button>
            </article>
          </div>
          <section
            v-if="state.userSettings?.connections.length"
            class="connected-accounts"
          >
            <h3>Connected accounts</h3>
            <article
              v-for="connection in state.userSettings.connections"
              :key="connection.connectionId"
              class="connected-account"
            >
              <div>
                <strong>{{ connection.displayName }}</strong>
                <small>{{ connection.state }}</small>
              </div>
              <button
                v-if="
                  connection.state !== 'revoked' &&
                  connection.state !== 'revoking'
                "
                type="button"
                @click="
                  revokePluginConnection(
                    connection.packageId,
                    connection.connectionId,
                  )
                "
              >
                Revoke
              </button>
            </article>
          </section>
          <p
            v-if="state.pluginCatalog.length === 0 && !state.settingsError"
            class="plugin-empty"
          >
            No connection Packages are available.
          </p>
          <p v-if="state.settingsError" class="settings-error" role="alert">
            {{ state.settingsError }}
          </p>
        </div>
      </section>
    </div>

    <div
      v-if="userSettingsOpen"
      class="settings-backdrop"
      role="presentation"
      @click.self="userSettingsOpen = false"
    >
      <section
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-settings-title"
      >
        <header class="settings-header">
          <button aria-label="Close settings" @click="userSettingsOpen = false">
            ‹
          </button>
          <h2 id="user-settings-title">Application settings</h2>
          <button aria-label="Close settings" @click="userSettingsOpen = false">
            ×
          </button>
        </header>
        <form class="settings-form" @submit.prevent="saveUserSettings">
          <div class="profile-face user-settings-face" aria-hidden="true" />
          <label>
            <span>Name</span>
            <input v-model="userSettingsName" maxlength="100" required />
          </label>
          <label>
            <span>Email <small>(optional)</small></span>
            <input v-model="userSettingsEmail" maxlength="320" type="email" />
          </label>
          <p v-if="state.settingsError" class="settings-error" role="alert">
            {{ state.settingsError }}
          </p>
          <button
            class="settings-save"
            type="submit"
            :disabled="settingsSaving"
          >
            {{ settingsSaving ? "Saving…" : "Save settings" }}
          </button>
        </form>
      </section>
    </div>

    <div
      v-if="settingsOpen"
      class="settings-backdrop"
      role="presentation"
      @click.self="settingsOpen = false"
    >
      <section
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-settings-title"
      >
        <header class="settings-header">
          <button aria-label="Close settings" @click="settingsOpen = false">
            ‹
          </button>
          <h2 id="bot-settings-title">Settings</h2>
          <button aria-label="Close settings" @click="settingsOpen = false">
            ×
          </button>
        </header>
        <form class="settings-form" @submit.prevent="saveSettings">
          <div class="settings-avatar" aria-hidden="true">⌁</div>
          <label>
            <span>Name</span>
            <input v-model="settingsName" maxlength="100" required />
          </label>
          <label>
            <span>Label <small>(optional)</small></span>
            <input
              v-model="settingsLabel"
              maxlength="120"
              placeholder="Research, marketing, admin"
            />
          </label>
          <label>
            <span>Description</span>
            <textarea
              v-model="settingsDescription"
              maxlength="10000"
              rows="7"
            />
          </label>
          <label class="notification-setting">
            <span>
              <strong>Notifications</strong>
              <small>Get notified when this Bot finishes or needs input</small>
            </span>
            <input v-model="settingsNotifications" type="checkbox" />
          </label>
          <p v-if="state.settingsError" class="settings-error" role="alert">
            {{ state.settingsError }}
          </p>
          <button
            class="settings-save"
            type="submit"
            :disabled="settingsSaving"
          >
            {{ settingsSaving ? "Saving…" : "Save settings" }}
          </button>
        </form>
      </section>
    </div>
  </div>
</template>
