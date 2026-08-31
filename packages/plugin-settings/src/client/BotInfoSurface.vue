<script setup lang="ts">
/**
 * The per-Bot info pane (parity register row 51).
 *
 * GrokBot opens it from the chat header and shows a live preview of the
 * agent's computer over its routines, plus channels when a channel connector
 * is available and members in group chats. FrockBot assembles the same pane
 * out of Contributions rather than one component: the Computer preview is the
 * Computer Package's `frockbot.computer` slot, the Routines glance and anything
 * later arrive through `frockbot.bot-info-sections`, and what this surface owns
 * is the Bot itself — identity, name provenance, the authority it holds, and
 * whether it may interrupt you.
 *
 * Channels are not built yet, so the pane says so in the place they will
 * mount rather than pretending the section does not exist. "Production
 * controls represent implemented backend behavior": the slot is labelled and
 * empty, and it offers nothing to click.
 */
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import { botAvatarUrl } from "./avatar-upload.js";
import { projectBotInfoV1 } from "./bot-info.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
const notificationsBusy = ref(false);

const info = computed(() =>
  projectBotInfoV1({
    settings: web.value.botSettings,
    catalog: web.value.pluginCatalog,
    connections: web.value.userSettings?.connections,
  }),
);
const avatarSrc = computed(() =>
  info.value?.avatarDigest
    ? botAvatarUrl(info.value.botId, info.value.avatarDigest)
    : undefined,
);

function link(anchor: string): string {
  return settingsLinkV1({ anchor, botId: web.value.activeBotId });
}

onMounted(() => {
  void web.value.loadBotSettings();
  void web.value.loadPluginCatalog();
  void web.value.loadUserSettings();
});

/*
 * The toggle writes immediately. It is one durable field with one command, and
 * a pane the User opened to look at should not grow a Save button for it.
 */
async function setNotifications(event: Event): Promise<void> {
  const enabled = (event.target as HTMLInputElement).checked;
  notificationsBusy.value = true;
  try {
    await web.value.saveBotNotifications({ enabled });
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not change notifications";
    await web.value.loadBotSettings();
  } finally {
    notificationsBusy.value = false;
  }
}
</script>

<template>
  <div class="bot-info">
    <p v-if="!info" class="bot-info__loading">Reading this Bot…</p>
    <template v-else>
      <UiAnchor
        as="section"
        anchor="bot-info-identity"
        label="Identity"
        :href="link('bot-info-identity')"
        class="bot-info__card bot-info__identity"
      >
        <span v-if="avatarSrc" class="bot-info__avatar">
          <img :src="avatarSrc" alt="" />
        </span>
        <span v-else class="bot-info__avatar" aria-hidden="true"
          ><UiIcon name="sparkle" size="lg"
        /></span>
        <div class="bot-info__identity-text">
          <h3>{{ info.name }}</h3>
          <p v-if="info.title" class="bot-info__title">{{ info.title }}</p>
          <p v-if="info.label" class="bot-info__label">{{ info.label }}</p>
          <p v-if="info.description" class="bot-info__description">
            {{ info.description }}
          </p>
          <p class="bot-info__provenance">{{ info.namedByLabel }}</p>
          <p v-if="info.hiddenFromSidebar" class="bot-info__provenance">
            Hidden from the sidebar
          </p>
        </div>
      </UiAnchor>

      <UiAnchor
        as="section"
        anchor="bot-info-members"
        label="Members"
        :href="link('bot-info-members')"
        class="bot-info__card"
      >
        <header class="bot-info__head">
          <h3>Members</h3>
          <span class="bot-info__count"
            >{{ info.enabledCapabilityCount }}/{{
              info.capabilities.length
            }}
            enabled</span
          >
        </header>
        <p class="bot-info__hint">
          This conversation has one member. What it can reach beyond the model
          is exactly its Capability Assignments.
        </p>
        <ul class="bot-info__members">
          <li class="bot-info__member">
            <span class="bot-info__member-name">{{ info.name }}</span>
            <span class="bot-info__member-note">Bot · {{ info.botId }}</span>
          </li>
        </ul>
        <ul v-if="info.capabilities.length > 0" class="bot-info__capabilities">
          <li v-for="capability in info.capabilities" :key="capability.key">
            <span class="bot-info__capability-name">
              {{ capability.packageName }} · {{ capability.capabilityId }}
            </span>
            <span class="bot-info__capability-note">
              {{ capability.state
              }}{{
                capability.connectionName
                  ? ` · ${capability.connectionName}`
                  : ""
              }}{{ capability.orphaned ? " · no longer in the catalog" : "" }}
            </span>
          </li>
        </ul>
        <p v-else class="bot-info__hint">
          No Capability is assigned to this Bot yet.
        </p>
        <UiButton type="button" @click="surfaces.open('bot-settings')">
          Manage Assignments
        </UiButton>
      </UiAnchor>

      <UiAnchor
        as="section"
        anchor="bot-info-computer"
        label="Computer"
        :href="link('bot-info-computer')"
        class="bot-info__card"
      >
        <header class="bot-info__head"><h3>Computer</h3></header>
        <!--
          The live preview is the Computer Package's own Contribution. The pane
          gives it a place and a heading and knows nothing about providers,
          viewers or leases.
        -->
        <k-slot name="frockbot.computer" />
      </UiAnchor>

      <!--
        Routines arrive here, and so will anything a later Package contributes.
      -->
      <k-slot name="frockbot.bot-info-sections" />

      <UiAnchor
        as="section"
        anchor="bot-info-channels"
        label="Channels"
        :href="link('bot-info-channels')"
        class="bot-info__card bot-info__card--empty"
      >
        <header class="bot-info__head"><h3>Channels</h3></header>
        <p class="bot-info__hint">
          Bot-to-Bot channels and external channel connectors are not built yet.
          When a Package contributes them they mount here.
        </p>
      </UiAnchor>

      <UiAnchor
        as="section"
        anchor="bot-info-notifications"
        label="Notifications"
        :href="link('bot-info-notifications')"
        class="bot-info__card"
      >
        <label class="bot-info__toggle">
          <span>
            <strong>Notifications</strong>
            <small>
              Tell me when this Bot finishes on its own or needs an answer.
            </small>
          </span>
          <input
            type="checkbox"
            :checked="info.notificationsEnabled"
            :disabled="notificationsBusy"
            @change="setNotifications"
          />
        </label>
      </UiAnchor>

      <p v-if="web.settingsError" class="settings-error" role="alert">
        {{ web.settingsError }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.bot-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.bot-info__loading {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.bot-info__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface);
}

.bot-info__card--empty {
  border-style: dashed;
  background: var(--frock-surface-subtle);
}

.bot-info__identity {
  flex-direction: row;
  align-items: flex-start;
}

.bot-info__avatar {
  display: grid;
  width: var(--frock-avatar-md);
  height: var(--frock-avatar-md);
  flex: 0 0 auto;
  overflow: hidden;
  place-items: center;
  border-radius: 50%;
  background: var(--frock-surface-accent);
  color: var(--frock-action-primary);
}

.bot-info__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bot-info__identity-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.bot-info__head {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  /* Room for the copy-link control the anchor floats in the corner. */
  padding-right: var(--frock-control-sm);
}

.bot-info h3 {
  margin: 0;
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.bot-info__identity h3 {
  font-size: var(--frock-text-lg);
}

.bot-info__count {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.bot-info__title,
.bot-info__label,
.bot-info__description,
.bot-info__provenance,
.bot-info__hint {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.bot-info__description {
  color: var(--frock-text);
  overflow-wrap: anywhere;
}

.bot-info__provenance {
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-xs);
}

.bot-info__members,
.bot-info__capabilities {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bot-info__member,
.bot-info__capabilities li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-subtle);
}

.bot-info__member-name,
.bot-info__capability-name {
  font-size: var(--frock-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.bot-info__member-note,
.bot-info__capability-note {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
  overflow-wrap: anywhere;
}

.bot-info__toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: var(--frock-control-sm);
}

.bot-info__toggle span {
  display: flex;
  flex-direction: column;
}

.bot-info__toggle small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
