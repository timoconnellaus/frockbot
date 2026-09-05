<script setup lang="ts">
import { UiButton, UiField } from "@frockbot/client-ui";
import {
  decodeModelSelection,
  describeModelBinding,
  eligibleModelConnections,
  encodeModelSelection,
  modelSelectOptions,
} from "@frockbot/plugin-settings/client";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref, watch } from "vue";
import {
  BOT_MODEL_SETTING_ID_V1,
  storedModelBindingV1,
} from "../model-settings.js";
import { customModelsClientStateKey } from "./state.js";

const providedState = inject(customModelsClientStateKey);
const providedWeb = inject(frockBotWebDataKey);
if (!providedState || !providedWeb) {
  throw new Error("Custom models client services were not provided");
}
const state = providedState;
const web = providedWeb;

const installation = computed(() =>
  web.value.userSettings?.packages.find(
    (candidate) => candidate.packageId === "custom-models",
  ),
);
const enabled = computed(() => installation.value?.state === "installed");
const connections = computed(() => web.value.userSettings?.connections ?? []);
const readyConnections = computed(() =>
  eligibleModelConnections({
    connections: connections.value,
    packages: web.value.userSettings?.packages ?? [],
    catalog: web.value.pluginCatalog,
  }),
);
const options = computed(() => modelSelectOptions(readyConnections.value));
const accountModel = computed(() =>
  storedModelBindingV1(web.value.userSettings?.accountModel),
);
const inheritedModel = computed(
  () => accountModel.value ?? web.value.userSettings?.platformModel,
);
const inheritedModelLabel = computed(
  () =>
    describeModelBinding(inheritedModel.value, connections.value) ??
    "not available",
);
const botModel = computed(() =>
  storedModelBindingV1(
    web.value.botSettings?.packageValues["custom-models"]?.[
      BOT_MODEL_SETTING_ID_V1
    ],
  ),
);
const selectedModel = ref("");
const saving = ref(false);

watch(
  () => encodeModelSelection(botModel.value),
  (selection) => {
    selectedModel.value = selection;
  },
  { immediate: true },
);

onMounted(() => {
  void web.value.loadPluginCatalog();
  void web.value.loadUserSettings();
  void web.value.loadBotSettings();
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await state.setBotModel(decodeModelSelection(selectedModel.value));
    web.value.settingsError = undefined;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save Bot model";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="enabled" class="bot-model-section">
    <UiField label="Model" hint="for this Bot">
      <select v-model="selectedModel">
        <option value="">
          Follow the account model — {{ inheritedModelLabel }}
        </option>
        <option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
    </UiField>
    <p class="field-hint">
      With no override, this Bot inherits {{ inheritedModelLabel }}.
    </p>
    <div class="section-actions">
      <UiButton variant="primary" :disabled="saving" @click="save">
        {{ saving ? "Saving…" : "Save Bot model" }}
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.bot-model-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: var(--frock-control-sm);
}

.field-hint {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.section-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
