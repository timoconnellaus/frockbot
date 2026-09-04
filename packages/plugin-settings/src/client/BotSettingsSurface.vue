<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import {
  UiAnchor,
  UiButton,
  UiField,
  UiIcon,
  UI_ANCHOR_EVENT,
  type UiAnchorEvent,
} from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;

function link(anchor: string): string {
  return settingsLinkV1({ anchor, botId: web.value.activeBotId });
}

const ADVANCED_ANCHORS = new Set([
  "bot-title",
  "bot-hidden-from-sidebar",
  "bot-routines",
  "bot-audit",
  "bot-info-identity",
  "bot-info-members",
]);
const advancedOpen = ref(false);

function openAdvancedFor(anchor: string): void {
  if (ADVANCED_ANCHORS.has(anchor)) advancedOpen.value = true;
}

function onAnchorAnnounced(event: Event): void {
  const anchor = (event as UiAnchorEvent).detail;
  openAdvancedFor(anchor);
  void nextTick(() =>
    document.getElementById(anchor)?.scrollIntoView({ block: "nearest" }),
  );
}

const name = ref("");
const label = ref("");
const description = ref("");
const title = ref("");
const hiddenFromSidebar = ref(false);
/*
 * Pinning is durable as the instant it happened, so the sidebar can order
 * pinned Bots by pin time. The panel edits the intent; the original instant is
 * kept across an unrelated save so re-saving never reshuffles the tiles.
 */
const pinned = ref(false);
const pinnedAt = ref("");
const notifications = ref(false);
const pendingApprovals = computed(() =>
  web.value.approvals.filter((approval) => approval.decision === "pending"),
);
const decidingApproval = ref<string>();
const saving = ref(false);

async function decideApproval(
  approvalId: string,
  decision: "approved" | "denied",
): Promise<void> {
  decidingApproval.value = approvalId;
  try {
    await web.value.decideApproval(approvalId, decision);
  } finally {
    decidingApproval.value = undefined;
  }
}

onMounted(() => {
  window.addEventListener(UI_ANCHOR_EVENT, onAnchorAnnounced);
  openAdvancedFor(decodeURIComponent(window.location.hash.replace(/^#/u, "")));
  void web.value.loadPluginCatalog();
  void web.value.loadBotSettings();
  void web.value.loadUserSettings();
});

const hydratedBotId = ref<string>();

watch(
  () => web.value.botSettings,
  (settings) => {
    if (!settings || hydratedBotId.value === settings.botId) return;
    hydratedBotId.value = settings.botId;
    name.value = settings.profile.name;
    label.value = settings.profile.label ?? "";
    description.value = settings.profile.description ?? "";
    title.value = settings.profile.title ?? "";
    hiddenFromSidebar.value = settings.profile.hiddenFromSidebar === true;
    pinnedAt.value = settings.profile.pinnedAt ?? "";
    pinned.value = pinnedAt.value !== "";
    notifications.value = settings.notifications.enabled;
  },
  { immediate: true },
);

onBeforeUnmount(() =>
  window.removeEventListener(UI_ANCHOR_EVENT, onAnchorAnnounced),
);

async function save(): Promise<void> {
  saving.value = true;
  try {
    await web.value.setBotProfile({
      name: name.value,
      label: label.value,
      description: description.value,
      title: title.value,
      hiddenFromSidebar: hiddenFromSidebar.value,
      pinnedAt: pinned.value
        ? pinnedAt.value || new Date().toISOString()
        : // The empty string unpins, the same way it clears an optional text field.
          "",
    });
    await web.value.saveBotNotifications({ enabled: notifications.value });
    surfaces.close();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save settings";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="settings-form" @submit.prevent="save">
    <UiAnchor
      anchor="bot-avatar"
      label="Avatar"
      :href="link('bot-avatar')"
      class="settings-row avatar-setting"
    >
      <k-slot name="frockbot.bot-avatar-editor" />
    </UiAnchor>
    <UiAnchor
      anchor="bot-name"
      label="Name"
      :href="link('bot-name')"
      class="settings-row"
    >
      <UiField label="Name">
        <input v-model="name" maxlength="100" required />
      </UiField>
    </UiAnchor>
    <UiAnchor
      anchor="bot-label"
      label="Label"
      :href="link('bot-label')"
      class="settings-row"
    >
      <UiField label="Label" hint="optional">
        <input
          v-model="label"
          maxlength="120"
          placeholder="Research, marketing, admin"
        />
      </UiField>
    </UiAnchor>
    <UiAnchor
      anchor="bot-pinned"
      label="Pinned"
      :href="link('bot-pinned')"
      class="settings-row"
    >
      <label class="notification-setting">
        <span>
          <strong>Pinned</strong>
          <small>
            Pin this Bot to the top of the sidebar. Unpin it to put it back in
            the list.
          </small>
        </span>
        <input v-model="pinned" type="checkbox" />
      </label>
    </UiAnchor>
    <UiAnchor
      anchor="bot-description"
      label="Description"
      :href="link('bot-description')"
      class="settings-row"
    >
      <UiField label="Description">
        <textarea v-model="description" maxlength="10000" rows="7" />
      </UiField>
    </UiAnchor>
    <div id="bot-info-notifications">
      <UiAnchor
        anchor="bot-notifications"
        label="Notifications"
        :href="link('bot-notifications')"
        class="settings-row"
      >
        <label class="notification-setting">
          <span>
            <strong>Notifications</strong>
            <small>Get notified when this Bot finishes or needs input</small>
          </span>
          <input v-model="notifications" type="checkbox" />
        </label>
      </UiAnchor>
    </div>
    <UiAnchor
      v-if="pendingApprovals.length > 0"
      anchor="bot-approvals"
      label="Waiting on you"
      :href="link('bot-approvals')"
      class="settings-row"
    >
      <ul class="pending-approvals">
        <li v-for="approval in pendingApprovals" :key="approval.approvalId">
          <span class="pending-approvals__risk">{{ approval.risk }}</span>
          <span class="pending-approvals__action">{{ approval.action }}</span>
          <span class="pending-approvals__actions">
            <UiButton
              :disabled="decidingApproval !== undefined"
              @click="decideApproval(approval.approvalId, 'approved')"
              >Approve</UiButton
            >
            <UiButton
              variant="ghost"
              :disabled="decidingApproval !== undefined"
              @click="decideApproval(approval.approvalId, 'denied')"
              >Deny</UiButton
            >
          </span>
        </li>
      </ul>
    </UiAnchor>

    <details
      class="advanced"
      :open="advancedOpen"
      @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        <span>Advanced</span>
        <span class="advanced__marker" aria-hidden="true"
          ><UiIcon name="arrow-down" size="sm"
        /></span>
      </summary>
      <div class="advanced__body">
        <UiAnchor
          anchor="bot-title"
          label="Title"
          :href="link('bot-title')"
          class="settings-row"
        >
          <UiField label="Title" hint="optional">
            <input
              v-model="title"
              maxlength="120"
              placeholder="Chief of staff, night-shift researcher"
            />
          </UiField>
        </UiAnchor>
        <UiAnchor
          anchor="bot-hidden-from-sidebar"
          label="Hidden from sidebar"
          :href="link('bot-hidden-from-sidebar')"
          class="settings-row"
        >
          <label class="notification-setting">
            <span>
              <strong>Hidden from sidebar</strong>
              <small
                >Keeps this Bot out of the list without archiving it.</small
              >
            </span>
            <input v-model="hiddenFromSidebar" type="checkbox" />
          </label>
        </UiAnchor>
        <UiAnchor
          anchor="bot-info-identity"
          label="Identity"
          :href="link('bot-info-identity')"
          class="bot-members"
        >
          <div>
            <strong>Identity</strong>
            <p>{{ name || "This Bot" }}</p>
          </div>
          <span>{{
            web.botSettings?.profile.namedBy === "bot"
              ? "Named by this Bot"
              : "Named by you"
          }}</span>
        </UiAnchor>
        <UiAnchor
          anchor="bot-info-members"
          label="Members"
          :href="link('bot-info-members')"
          class="bot-members"
        >
          <div>
            <strong>Members</strong>
            <p>This Bot uses what you enable for all of your Bots.</p>
          </div>
          <span>Plugins and connected accounts are shared</span>
        </UiAnchor>
        <k-slot name="frockbot.bot-settings-sections" />
      </div>
    </details>
    <div class="primary-contributions">
      <k-slot name="frockbot.bot-settings-primary-sections" />
    </div>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
    <div class="settings-actions">
      <UiButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save settings" }}
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.settings-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: var(--frock-control-sm);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.notification-setting,
.bot-members {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.avatar-setting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-right: 0;
}

.bot-members {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
}

.bot-members strong,
.bot-members p {
  display: block;
  margin: 0;
}

.bot-members strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
}

.bot-members p,
.bot-members > span {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.bot-members > span {
  max-width: 120px;
  flex: 0 0 auto;
  text-align: right;
}

.notification-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
}

.notification-setting strong,
.notification-setting small {
  display: block;
}

.notification-setting strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.notification-setting input[type="checkbox"] {
  position: relative;
  width: 38px;
  height: 22px;
  flex: 0 0 auto;
  appearance: none;
  border: 1px solid var(--frock-border-strong);
  border-radius: 999px;
  background: var(--frock-fill-pressed);
  cursor: pointer;
  transition: background-color var(--frock-motion-fast);
}

.notification-setting input[type="checkbox"]::before {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-control);
  content: "";
  transition: transform var(--frock-motion-fast);
}

.notification-setting input[type="checkbox"]:checked {
  border-color: var(--frock-action-primary);
  background: var(--frock-action-primary);
}

.notification-setting input[type="checkbox"]:checked::before {
  transform: translateX(16px);
}

.notification-setting input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--frock-focus-ring);
  outline-offset: 2px;
}

.pending-approvals {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pending-approvals li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 0.5rem 0.75rem;
}

.pending-approvals__risk {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  padding: 0.125rem 0.5rem;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
  text-transform: uppercase;
}

.pending-approvals__action {
  flex: 1 1 12rem;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.pending-approvals__actions {
  display: flex;
  gap: 0.5rem;
}

.primary-contributions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.advanced {
  border-top: 1px solid var(--frock-border);
  padding-top: 12px;
}

.advanced summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.advanced summary::-webkit-details-marker {
  display: none;
}

.advanced__marker {
  display: grid;
  place-items: center;
  transition: transform var(--frock-motion-fast);
}

.advanced[open] .advanced__marker {
  transform: rotate(180deg);
}

.advanced__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 12px;
}
</style>
