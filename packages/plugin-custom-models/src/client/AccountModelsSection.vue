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
  ACCOUNT_MODEL_SETTING_ID_V1,
  storedModelBindingV1,
} from "../model-settings.js";
import ProviderAccounts from "./ProviderAccounts.vue";
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
const storedModel = computed(() =>
  storedModelBindingV1(
    installation.value?.values?.[ACCOUNT_MODEL_SETTING_ID_V1],
  ),
);
const platformModelLabel = computed(
  () =>
    describeModelBinding(
      web.value.userSettings?.platformModel,
      connections.value,
    ) ?? "not available",
);
const selectedModel = ref("");
const saving = ref(false);

watch(
  () => encodeModelSelection(storedModel.value),
  (selection) => {
    selectedModel.value = selection;
  },
  { immediate: true },
);

onMounted(() => {
  void web.value.loadPluginCatalog();
  void web.value.loadUserSettings();
});

async function save(): Promise<void> {
  saving.value = true;
  try {
    await state.setAccountModel(decodeModelSelection(selectedModel.value));
    web.value.settingsError = undefined;
  } catch (error) {
    web.value.settingsError =
      error instanceof Error ? error.message : "Could not save account model";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="enabled" class="custom-models">
    <section
      id="user-default-model-content"
      class="model-section"
      aria-labelledby="user-default-model"
    >
      <UiField label="Account model" hint="used by every Bot">
        <select v-model="selectedModel">
          <option value="">
            Follow the platform model — {{ platformModelLabel }}
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
        With no account choice, every Bot follows the platform model:
        {{ platformModelLabel }}.
      </p>
      <div class="section-actions">
        <UiButton variant="primary" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save account model" }}
        </UiButton>
      </div>
    </section>

    <section
      id="user-model-providers-content"
      class="model-section"
      aria-labelledby="user-model-providers"
    >
      <div>
        <strong>Model providers</strong>
        <p class="field-hint">
          Accounts and endpoints for the model providers you have enabled.
        </p>
      </div>
      <ProviderAccounts />
    </section>
  </div>
</template>

<style scoped>
.custom-models,
.model-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.model-section {
  padding-right: var(--frock-control-sm);
}

.model-section + .model-section {
  padding-top: 16px;
  border-top: 1px solid var(--frock-border);
}

.model-section strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
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
