<script setup lang="ts">
/**
 * The knobs one Package declares, wherever that Package's configuration lives.
 * Rendered from the manifest, so a Package that adds a setting needs no edit
 * here and none to the surface that hosts this form.
 */
import { UiButton } from "@frockbot/client-ui";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, ref, watch } from "vue";
import {
  collectSettingsValues,
  seedSettingsDraft,
  settingFieldKind,
  settingLabel,
} from "./package-settings.js";

const props = defineProps<{ item: PluginCatalogItem }>();

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;

const definitions = computed(() =>
  (props.item.settings ?? []).filter(
    (definition) =>
      definition.role !== "model" && definition.scopes.includes("user"),
  ),
);
const draft = ref<Record<string, string | number | boolean>>({});

/** The stored values of this Package, as the User settings hold them. */
const stored = computed<Record<string, unknown>>(() => {
  const installation = web.value.userSettings?.packages.find(
    (candidate) => candidate.packageId === props.item.packageId,
  );
  return (installation?.values ?? {}) as Record<string, unknown>;
});

watch(
  [definitions, stored],
  () => {
    draft.value = seedSettingsDraft(definitions.value, stored.value);
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const values = collectSettingsValues(definitions.value, draft.value);
  if (Object.keys(values).length === 0) return;
  try {
    await web.value.savePackageSettings(props.item.packageId, values);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : "Could not save the Package settings";
  }
}
</script>

<template>
  <form
    v-if="definitions.length > 0"
    class="package-settings-form"
    @submit.prevent="save"
  >
    <label
      v-for="definition in definitions"
      :key="definition.id"
      :class="{
        'field-toggle': settingFieldKind(definition.schema) === 'boolean',
      }"
    >
      <span>{{ settingLabel(definition) }}</span>
      <select
        v-if="settingFieldKind(definition.schema) === 'enum'"
        v-model="draft[definition.id]"
      >
        <option value="">Package default</option>
        <option
          v-for="choice in definition.schema.enum ?? []"
          :key="String(choice)"
          :value="choice ?? ''"
        >
          {{ String(choice) }}
        </option>
      </select>
      <input
        v-else-if="settingFieldKind(definition.schema) === 'boolean'"
        v-model="draft[definition.id]"
        type="checkbox"
      />
      <input
        v-else-if="settingFieldKind(definition.schema) === 'number'"
        v-model="draft[definition.id]"
        type="number"
        inputmode="numeric"
        :min="definition.schema.minimum"
        :max="definition.schema.maximum"
        :step="definition.schema.type === 'integer' ? 1 : 'any'"
      />
      <input
        v-else
        v-model="draft[definition.id]"
        type="text"
        :maxlength="definition.schema.maxLength"
      />
      <small v-if="definition.schema.description" class="field-hint">
        {{ definition.schema.description }}
      </small>
    </label>
    <div class="package-settings-actions">
      <UiButton type="submit" variant="primary">Save settings</UiButton>
    </div>
  </form>
</template>

<style scoped>
.package-settings-form {
  display: grid;
  gap: 12px;
  margin: 0 8px;
  padding: 12px 0 8px;
  border-top: 1px solid var(--frock-border);
}

.package-settings-form label {
  display: grid;
  gap: 6px;
}

.package-settings-form span {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.package-settings-form input,
.package-settings-form select {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: 9px;
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

/*
 * A checkbox reads beside its label, not under it. Sized and padded like a
 * text field it drew as an empty box centred in the card with nothing next to
 * it, and nothing on screen said what ticking it would do.
 */
.package-settings-form label.field-toggle {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 4px 8px;
}

.package-settings-form label.field-toggle span {
  order: 2;
  color: var(--frock-text);
}

.package-settings-form label.field-toggle input[type="checkbox"] {
  order: 1;
  width: 16px;
  height: 16px;
  padding: 0;
}

.package-settings-form label.field-toggle .field-hint {
  order: 3;
  grid-column: 1 / -1;
}

.field-hint {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.package-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
