<script setup lang="ts">
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { UiButton, UiField } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, reactive, ref } from "vue";
import {
  assignmentHasPendingOperation,
  projectAssignmentOperations,
} from "./assignment-operations.js";
import {
  isModelConnectionEligible,
  resolveBotSettingsModel,
} from "./bot-settings.js";
import CompositionSection from "./CompositionSection.vue";

const providedSurfaces = inject(clientSurfaceRegistryKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedSurfaces || !providedWeb) {
  throw new Error("settings client services were not provided");
}
const surfaces = providedSurfaces;
const web = providedWeb;
const name = ref("");
const label = ref("");
const description = ref("");
const notifications = ref(false);
const saving = ref(false);
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
  (web.value.userSettings?.connections ?? []).filter((connection) =>
    isModelConnectionEligible({
      connection,
      packages: web.value.userSettings?.packages ?? [],
      catalog: web.value.pluginCatalog,
    }),
  ),
);
const modelOptions = computed(() =>
  readyConnections.value.flatMap((connection) =>
    (connection.modelCatalog?.models ?? []).map((model) => ({
      value: JSON.stringify([connection.connectionId, model.providerModelId]),
      label: `${model.displayName} — ${connection.displayName}`,
    })),
  ),
);

onMounted(async () => {
  await Promise.all([
    web.value.loadPluginCatalog(),
    web.value.loadBotSettings(),
    web.value.loadUserSettings(),
  ]);
  const settings = web.value.botSettings;
  if (!settings) return;
  name.value = settings.profile.name;
  label.value = settings.profile.label ?? "";
  description.value = settings.profile.description ?? "";
  notifications.value = settings.notifications.enabled;
  selectedModel.value = settings.model
    ? JSON.stringify([
        settings.model.connectionId,
        settings.model.providerModelId,
      ])
    : "";
  exactConnectionId.value =
    settings.model?.connectionId ??
    readyConnections.value[0]?.connectionId ??
    "";
  exactProviderModelId.value = settings.model?.providerModelId ?? "";
  useExactModel.value = Boolean(
    settings.model &&
    !modelOptions.value.some((model) => model.value === selectedModel.value),
  );
});

async function clearModel(): Promise<void> {
  saving.value = true;
  try {
    await web.value.clearBotModel();
    selectedModel.value = "";
    exactProviderModelId.value = "";
    useExactModel.value = false;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not unbind model";
  } finally {
    saving.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const current = web.value.botSettings?.model;
    const selected = resolveBotSettingsModel({
      current,
      useExactModel: useExactModel.value,
      selectedModel: selectedModel.value,
      exactConnectionId: exactConnectionId.value,
      exactProviderModelId: exactProviderModelId.value,
    });
    await web.value.saveBotProfile({
      name: name.value,
      label: label.value || undefined,
      description: description.value || undefined,
    });
    if (selected) await web.value.saveBotModel(selected);
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
    <div class="settings-intro">
      <span class="settings-avatar" aria-hidden="true">⌁</span>
      <div>
        <strong>Shape this Bot</strong>
        <p>
          Identity, Assignments, and notifications belong to the selected Bot.
        </p>
      </div>
    </div>
    <UiField label="Name">
      <input v-model="name" maxlength="100" required />
    </UiField>
    <UiField label="Label" hint="optional">
      <input
        v-model="label"
        maxlength="120"
        placeholder="Research, marketing, admin"
      />
    </UiField>
    <UiField label="Description">
      <textarea v-model="description" maxlength="10000" rows="7" />
    </UiField>

    <section class="assignment-settings">
      <div>
        <strong>Capability Assignments</strong>
        <p>Grant this Bot an installed Capability and required Connection.</p>
      </div>
      <article
        v-for="item in capabilityItems"
        :key="item.key"
        class="assignment-card"
      >
        <div>
          <strong>{{ item.pkg.displayName }} · {{ item.capability.id }}</strong>
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
              :disabled="Boolean(item.pending) || assignmentBusy === item.key"
              @click="replace(item)"
            >
              Replace
            </UiButton>
            <UiButton
              type="button"
              variant="danger"
              :disabled="Boolean(item.pending) || assignmentBusy === item.key"
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
            >{{ assignment.packageId }} · {{ assignment.capabilityId }}</strong
          >
          <small
            >{{ assignment.state }} · no longer available in the catalog</small
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
        v-if="capabilityItems.length === 0 && orphanAssignments.length === 0"
        class="assignment-empty"
      >
        No assignable Capabilities are available in the production catalog.
      </p>
    </section>

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
    <label class="notification-setting">
      <span>
        <strong>Notifications</strong>
        <small>Get notified when this Bot finishes or needs input.</small>
      </span>
      <input v-model="notifications" type="checkbox" />
    </label>
    <p v-if="web.settingsError" class="settings-error" role="alert">
      {{ web.settingsError }}
    </p>
    <div class="settings-actions">
      <UiButton
        v-if="web.botSettings?.model"
        type="button"
        :disabled="saving"
        @click="clearModel"
      >
        Unbind model
      </UiButton>
      <UiButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save settings" }}
      </UiButton>
    </div>
    <CompositionSection />
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
}

.settings-intro,
.assignment-card,
.notification-setting {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.settings-intro {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px;
}

.settings-avatar {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 16px;
  color: var(--frock-action-secondary-text);
  background: var(--frock-surface-accent);
  font-size: 23px;
}

.settings-intro strong,
.settings-intro p,
.assignment-settings p {
  display: block;
  margin: 0;
}

.settings-intro p,
.assignment-settings p,
.assignment-card small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.assignment-settings {
  display: grid;
  gap: 10px;
}

.assignment-card {
  display: grid;
  gap: 10px;
  padding: 14px;
}

.assignment-card small {
  display: block;
}

.assignment-card select {
  width: 100%;
}

.assignment-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.assignment-empty {
  padding: 12px;
  border: 1px dashed var(--frock-border);
  border-radius: var(--frock-radius-card);
}

.exact-model-setting,
.notification-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px;
}

.exact-model-setting strong,
.exact-model-setting small,
.notification-setting strong,
.notification-setting small {
  display: block;
}

.exact-model-setting small,
.notification-setting small {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: 11px;
}

.exact-model-setting input,
.notification-setting input {
  width: 19px;
  height: 19px;
  accent-color: var(--frock-action-primary);
}

.settings-error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: 12px;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
