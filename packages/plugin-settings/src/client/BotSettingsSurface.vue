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
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  nextTick,
  watch,
} from "vue";
import {
  assignmentHasPendingOperation,
  projectAssignmentOperations,
} from "./assignment-operations.js";
import {
  describeModelAssignment,
  eligibleModelConnections,
  encodeModelSelection,
  modelSelectOptions,
  resolveBotSettingsModel,
} from "./bot-settings.js";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;

/*
 * Every row below is deep-linkable. The scheme and the anchor table live in
 * `@frockbot/plugin-shell/settings-links`, so a Bot citing a row and the panel
 * rendering it read the same list — a link nobody registered does not resolve,
 * and a row nobody linked has no link to copy.
 */
function link(anchor: string): string {
  return settingsLinkV1({ anchor, botId: web.value.activeBotId });
}

/*
 * Model and Assignments live under the Advanced disclosure, and a collapsed
 * `details` cannot be scrolled to. A link into either opens it first; the User
 * can still close it, and the `toggle` handler keeps their choice.
 */
const ADVANCED_ANCHORS = new Set([
  "bot-title",
  "bot-hidden-from-sidebar",
  "bot-model",
  "bot-capabilities",
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
const notifications = ref(false);
/**
 * The Bot's undecided approval cards. Read from the same backend state the
 * conversation renders, so the two surfaces cannot disagree about what is
 * still waiting.
 */
const pendingApprovals = computed(() =>
  web.value.approvals.filter((approval) => approval.decision === "pending"),
);
const decidingApproval = ref<string>();

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
const saving = ref(false);
const modelMode = ref<"default" | "custom">("default");
const assignmentBusy = ref<string>();
const selectedConnections = reactive<Record<string, string>>({});

const capabilityItems = computed(() =>
  web.value.pluginCatalog.flatMap((pkg) =>
    web.value.userSettings?.packages.some(
      (installation) =>
        installation.packageId === pkg.packageId &&
        installation.version === pkg.version &&
        installation.state === "installed",
    )
      ? pkg.capabilities.map((capability) => {
          const existing = web.value.botSettings?.assignments.find(
            (assignment) =>
              assignment.packageId === pkg.packageId &&
              assignment.capabilityId === capability.id,
          );
          const pending = web.value.botSettings?.assignmentOperations.find(
            (operation) =>
              operation.assignmentId === existing?.assignmentId ||
              (operation.target?.packageId === pkg.packageId &&
                operation.target.capabilityId === capability.id),
          );
          const connections =
            web.value.userSettings?.connections.filter(
              (connection) =>
                connection.packageId === pkg.packageId &&
                connection.state === "ready" &&
                capability.connectionTypes.includes(
                  connection.connectionTypeId,
                ),
            ) ?? [];
          const key = `${pkg.packageId}:${capability.id}`;
          if (!(key in selectedConnections) && existing?.connectionId) {
            selectedConnections[key] = existing.connectionId;
          }
          return { key, pkg, capability, existing, pending, connections };
        })
      : [],
  ),
);

const assignmentOperations = computed(() =>
  projectAssignmentOperations(web.value.botSettings),
);

const orphanAssignments = computed(
  () =>
    web.value.botSettings?.assignments.filter(
      (assignment) =>
        !capabilityItems.value.some(
          (item) => item.existing?.assignmentId === assignment.assignmentId,
        ),
    ) ?? [],
);

function assignmentOperationPending(assignmentId: string): boolean {
  return assignmentHasPendingOperation(
    assignmentOperations.value,
    assignmentId,
  );
}

const selectedModel = ref("");
const useExactModel = ref(false);
const exactConnectionId = ref("");
const exactProviderModelId = ref("");
const readyConnections = computed(() =>
  eligibleModelConnections({
    connections: web.value.userSettings?.connections ?? [],
    packages: web.value.userSettings?.packages ?? [],
    catalog: web.value.pluginCatalog,
  }),
);
const modelOptions = computed(() => modelSelectOptions(readyConnections.value));
const defaultModelName = computed(
  () =>
    describeModelAssignment(
      web.value.userSettings?.newBotModelTemplate,
      web.value.userSettings?.connections ?? [],
    ) ?? "none set",
);
const overriding = computed(() => Boolean(web.value.botSettings?.model));

onMounted(() => {
  window.addEventListener(UI_ANCHOR_EVENT, onAnchorAnnounced);
  openAdvancedFor(decodeURIComponent(window.location.hash.replace(/^#/u, "")));
  void web.value.loadPluginCatalog();
  void web.value.loadBotSettings();
  void web.value.loadUserSettings();
});

/*
 * The form fills itself from whichever Bot's durable settings arrive, rather
 * than from whatever had loaded by the time this panel mounted. A deep link
 * opens the panel before the Flock has selected a Bot, and a User can switch
 * Bots with the panel open; both used to leave the fields on screen belonging
 * to nobody.
 */
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
    notifications.value = settings.notifications.enabled;
    modelMode.value = settings.model ? "custom" : "default";
    selectedModel.value = encodeModelSelection(settings.model);
    exactConnectionId.value =
      settings.model?.connectionId ??
      readyConnections.value[0]?.connectionId ??
      "";
    exactProviderModelId.value = settings.model?.providerModelId ?? "";
    useExactModel.value = Boolean(
      settings.model &&
      !modelOptions.value.some((model) => model.value === selectedModel.value),
    );
  },
  { immediate: true },
);

// The Connections may land after the Bot did; an empty exact-model Connection
// takes the first ready one the moment there is one.
watch(readyConnections, (connections) => {
  if (!exactConnectionId.value && connections[0]) {
    exactConnectionId.value = connections[0].connectionId;
  }
});

onBeforeUnmount(() =>
  window.removeEventListener(UI_ANCHOR_EVENT, onAnchorAnnounced),
);

async function saveModel(): Promise<void> {
  if (modelMode.value === "default") {
    // Following the default means holding no Bot binding at all.
    if (web.value.botSettings?.model) await web.value.clearBotModel();
    return;
  }
  const selected = resolveBotSettingsModel({
    current: web.value.botSettings?.model,
    useExactModel: useExactModel.value,
    selectedModel: selectedModel.value,
    exactConnectionId: exactConnectionId.value,
    exactProviderModelId: exactProviderModelId.value,
  });
  if (selected) await web.value.saveBotModel(selected);
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    // A partial update: the empty string clears an optional field.
    await web.value.setBotProfile({
      name: name.value,
      label: label.value,
      description: description.value,
      title: title.value,
      hiddenFromSidebar: hiddenFromSidebar.value,
    });
    await saveModel();
    await web.value.saveBotNotifications({ enabled: notifications.value });
    surfaces.close();
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save settings";
  } finally {
    saving.value = false;
  }
}

async function assign(
  item: (typeof capabilityItems.value)[number],
): Promise<void> {
  assignmentBusy.value = item.key;
  try {
    await web.value.assignCapability({
      assignmentId: crypto.randomUUID(),
      packageId: item.pkg.packageId,
      capabilityId: item.capability.id,
      connectionId: selectedConnections[item.key] || undefined,
    });
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not assign Capability";
    await web.value.loadBotSettings();
  } finally {
    assignmentBusy.value = undefined;
  }
}

async function replace(
  item: (typeof capabilityItems.value)[number],
): Promise<void> {
  if (!item.existing) return;
  assignmentBusy.value = item.key;
  try {
    await web.value.replaceCapability({
      assignmentId: item.existing.assignmentId,
      packageId: item.pkg.packageId,
      capabilityId: item.capability.id,
      connectionId: selectedConnections[item.key] || undefined,
    });
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not replace Assignment";
    await web.value.loadBotSettings();
  } finally {
    assignmentBusy.value = undefined;
  }
}

async function unassignAssignment(
  assignmentId: string,
  key: string,
): Promise<void> {
  assignmentBusy.value = key;
  try {
    await web.value.unassignCapability(assignmentId);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not unassign Capability";
    await web.value.loadBotSettings();
  } finally {
    assignmentBusy.value = undefined;
  }
}

async function unassign(
  item: (typeof capabilityItems.value)[number],
): Promise<void> {
  if (!item.existing) return;
  await unassignAssignment(item.existing.assignmentId, item.key);
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
    <!--
      Pending decisions. The card in the conversation is where a decision is
      normally answered; this is where the ones nobody scrolled back to are
      still findable, because "a request for more authority becomes a durable
      pending decision for the User" is only true if the User can find it.
    -->
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
            <p>{{ name || "This Bot" }} · Bot {{ web.activeBotId }}</p>
          </div>
          <span>
            Named by {{ web.botSettings?.profile.namedBy ?? "user" }}
          </span>
        </UiAnchor>
        <UiAnchor
          anchor="bot-info-members"
          label="Members"
          :href="link('bot-info-members')"
          class="bot-members"
        >
          <div>
            <strong>Members</strong>
            <p>This Bot and the authority explicitly assigned to it.</p>
          </div>
          <span>
            {{ web.botSettings?.assignments.length ?? 0 }} Capability
            Assignment(s)
          </span>
        </UiAnchor>
        <p v-if="overriding" class="model-note">Overrides default model</p>
        <UiAnchor
          anchor="bot-model"
          label="Model"
          :href="link('bot-model')"
          class="settings-row"
        >
          <fieldset class="model-mode">
            <legend>Model</legend>
            <label>
              <input v-model="modelMode" type="radio" value="default" />
              <span>Use default model ({{ defaultModelName }})</span>
            </label>
            <label>
              <input v-model="modelMode" type="radio" value="custom" />
              <span>Custom model</span>
            </label>
          </fieldset>
        </UiAnchor>
        <template v-if="modelMode === 'custom'">
          <label class="exact-model-setting">
            <span>
              <strong>Use exact model ID</strong>
              <small>Choose a model not listed in the advisory catalog.</small>
            </span>
            <input v-model="useExactModel" type="checkbox" />
          </label>
          <template v-if="useExactModel">
            <UiField label="Connection">
              <select v-model="exactConnectionId">
                <option disabled value="">Select a Connection</option>
                <option
                  v-for="connection in readyConnections"
                  :key="connection.connectionId"
                  :value="connection.connectionId"
                >
                  {{ connection.displayName }}
                </option>
              </select>
            </UiField>
            <UiField label="Exact provider model ID">
              <input
                v-model="exactProviderModelId"
                maxlength="256"
                placeholder="model-name:cloud"
              />
            </UiField>
          </template>
          <UiField v-else label="Model">
            <select v-model="selectedModel">
              <option disabled value="">Select a connected model</option>
              <option
                v-for="model in modelOptions"
                :key="model.value"
                :value="model.value"
              >
                {{ model.label }}
              </option>
            </select>
          </UiField>
        </template>
        <UiAnchor
          anchor="bot-capabilities"
          label="Capability Assignments"
          :href="link('bot-capabilities')"
          class="settings-row"
        >
          <section class="assignment-settings">
            <div>
              <strong>Capability Assignments</strong>
              <p>
                Grant this Bot an installed Capability and required Connection.
              </p>
            </div>
            <article
              v-for="item in capabilityItems"
              :key="item.key"
              class="assignment-card"
            >
              <div>
                <strong
                  >{{ item.pkg.displayName }} · {{ item.capability.id }}</strong
                >
                <small v-if="item.pending">
                  {{ item.pending.kind }} · {{ item.pending.state }}
                </small>
                <small v-else-if="item.existing">
                  {{ item.existing.state }}
                </small>
                <small v-else>Not assigned</small>
              </div>
              <select
                v-if="item.capability.connectionTypes.length > 0"
                v-model="selectedConnections[item.key]"
                :disabled="Boolean(item.pending)"
                :aria-label="`Connection for ${item.capability.id}`"
              >
                <option value="">Choose a ready Connection</option>
                <option
                  v-for="connection in item.connections"
                  :key="connection.connectionId"
                  :value="connection.connectionId"
                >
                  {{ connection.displayName }}
                </option>
              </select>
              <div class="assignment-actions">
                <UiButton
                  v-if="!item.existing"
                  type="button"
                  :disabled="
                    Boolean(item.pending) ||
                    assignmentBusy === item.key ||
                    (item.capability.connectionTypes.length > 0 &&
                      !selectedConnections[item.key])
                  "
                  @click="assign(item)"
                >
                  Assign
                </UiButton>
                <template v-else>
                  <UiButton
                    type="button"
                    :disabled="
                      Boolean(item.pending) || assignmentBusy === item.key
                    "
                    @click="replace(item)"
                  >
                    Replace
                  </UiButton>
                  <UiButton
                    type="button"
                    variant="danger"
                    :disabled="
                      Boolean(item.pending) || assignmentBusy === item.key
                    "
                    @click="unassign(item)"
                  >
                    Unassign
                  </UiButton>
                </template>
              </div>
            </article>
            <article
              v-for="operation in assignmentOperations"
              :key="`operation:${operation.commandId}`"
              class="assignment-card"
              data-assignment-operation
            >
              <div>
                <strong>
                  {{ operation.target?.packageId ?? "Unavailable Package" }} ·
                  {{ operation.target?.capabilityId ?? operation.assignmentId }}
                </strong>
                <small>{{ operation.kind }} · {{ operation.state }}</small>
              </div>
            </article>
            <article
              v-for="assignment in orphanAssignments"
              :key="assignment.assignmentId"
              class="assignment-card"
            >
              <div>
                <strong
                  >{{ assignment.packageId }} ·
                  {{ assignment.capabilityId }}</strong
                >
                <small
                  >{{ assignment.state }} · no longer available in the
                  catalog</small
                >
              </div>
              <div class="assignment-actions">
                <UiButton
                  type="button"
                  variant="danger"
                  :disabled="
                    assignmentBusy === assignment.assignmentId ||
                    assignmentOperationPending(assignment.assignmentId)
                  "
                  @click="
                    unassignAssignment(
                      assignment.assignmentId,
                      assignment.assignmentId,
                    )
                  "
                >
                  Unassign
                </UiButton>
              </div>
            </article>
            <p
              v-if="
                capabilityItems.length === 0 && orphanAssignments.length === 0
              "
              class="assignment-empty"
            >
              No assignable Capabilities are available in the production
              catalog.
            </p>
          </section>
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
/*
 * A deep-linkable row. The anchor floats its copy control in the top-right
 * corner, so every row keeps that corner clear.
 */
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

.assignment-card,
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

.assignment-settings p,
.assignment-card small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.assignment-settings {
  display: grid;
  gap: 10px;
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
  max-width: 110px;
  flex: 0 0 auto;
  text-align: right;
}

.assignment-settings strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.assignment-card {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.assignment-card strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.assignment-card small {
  display: block;
}

.assignment-card select {
  width: 100%;
}

.assignment-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

/* The right panel is ~360px wide, so Assignment controls stay compact. */
.assignment-actions :deep(.ui-button) {
  min-height: 30px;
  padding: 0 10px;
  font-size: var(--frock-text-sm);
}

.assignment-empty {
  padding: 12px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  border: 1px dashed var(--frock-border);
  border-radius: var(--frock-radius-card);
}

.exact-model-setting,
.notification-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.exact-model-setting strong,
.exact-model-setting small,
.notification-setting strong,
.notification-setting small {
  display: block;
}

.notification-setting strong,
.exact-model-setting strong {
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.exact-model-setting small,
.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.exact-model-setting input[type="checkbox"],
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

.exact-model-setting input[type="checkbox"]::before,
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

.exact-model-setting input[type="checkbox"]:checked,
.notification-setting input[type="checkbox"]:checked {
  border-color: var(--frock-action-primary);
  background: var(--frock-action-primary);
}

.exact-model-setting input[type="checkbox"]:checked::before,
.notification-setting input[type="checkbox"]:checked::before {
  transform: translateX(16px);
}

.exact-model-setting input[type="checkbox"]:focus-visible,
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

.model-note {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
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
  gap: 12px;
  padding-top: 12px;
}

.model-mode {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  border: 0;
  padding: 0;
}

.model-mode legend {
  float: left;
  width: 100%;
  margin-bottom: 4px;
  padding: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.model-mode label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  cursor: pointer;
}

.model-mode input {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  accent-color: var(--frock-action-primary);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}

.primary-contributions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
