<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import type {
  PackageSettingDefinition,
  PackageSettingSchema,
} from "@frockbot/kernel-composition";
import {
  frockBotWebDataKey,
  type PluginCatalogItem,
} from "@frockbot/plugin-shell/shared";
import { computed, inject, ref, watch } from "vue";

const props = defineProps<{ item: PluginCatalogItem }>();

const providedWeb = inject(frockBotWebDataKey);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;

type FieldKind = "enum" | "boolean" | "number" | "text";
type DraftValue = string | number | boolean;

function fieldKind(schema: PackageSettingSchema): FieldKind {
  if (schema.enum && schema.enum.length > 0) return "enum";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "text";
}

function label(definition: PackageSettingDefinition): string {
  return definition.schema.title ?? definition.id;
}

const definitions = computed(() =>
  (props.item.settings ?? []).filter(
    (definition) =>
      definition.role !== "model" && definition.scopes.includes("user"),
  ),
);
const stored = computed<Record<string, unknown>>(() => {
  const installation = web.value.userSettings?.packages.find(
    (candidate) => candidate.packageId === props.item.packageId,
  );
  return (installation?.values ?? {}) as Record<string, unknown>;
});
const draft = ref<Record<string, DraftValue>>({});

watch(
  [definitions, stored],
  () => {
    draft.value = Object.fromEntries(
      definitions.value.map((definition) => {
        const value = stored.value[definition.id];
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return [definition.id, value];
        }
        return [
          definition.id,
          fieldKind(definition.schema) === "boolean" ? false : "",
        ];
      }),
    );
  },
  { immediate: true },
);

function values(): Record<string, DraftValue> {
  const result: Record<string, DraftValue> = {};
  for (const definition of definitions.value) {
    const kind = fieldKind(definition.schema);
    const value = draft.value[definition.id];
    if (kind === "boolean") {
      result[definition.id] = value === true;
    } else if (value !== "" && value !== undefined) {
      const normalized = kind === "number" ? Number(value) : String(value);
      if (typeof normalized !== "number" || Number.isFinite(normalized)) {
        result[definition.id] = normalized;
      }
    }
  }
  return result;
}

async function save(): Promise<void> {
  const patch = values();
  if (Object.keys(patch).length === 0) return;
  try {
    await web.value.savePackageSettings(props.item.packageId, patch);
  } catch (error) {
    web.value.settingsError =
      error instanceof Error
        ? error.message
        : "Could not save the provider settings";
  }
}
</script>

<template>
  <form
    v-if="definitions.length > 0"
    class="provider-settings"
    @submit.prevent="save"
  >
    <label v-for="definition in definitions" :key="definition.id">
      <span>{{ label(definition) }}</span>
      <select
        v-if="fieldKind(definition.schema) === 'enum'"
        v-model="draft[definition.id]"
      >
        <option value="">Default</option>
        <option
          v-for="choice in definition.schema.enum ?? []"
          :key="String(choice)"
          :value="choice ?? ''"
        >
          {{ String(choice) }}
        </option>
      </select>
      <input
        v-else-if="fieldKind(definition.schema) === 'boolean'"
        v-model="draft[definition.id]"
        type="checkbox"
      />
      <input
        v-else-if="fieldKind(definition.schema) === 'number'"
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
      <small v-if="definition.schema.description">
        {{ definition.schema.description }}
      </small>
    </label>
    <div class="provider-settings__actions">
      <UiButton type="submit" variant="primary">Save settings</UiButton>
    </div>
  </form>
</template>

<style scoped>
.provider-settings {
  display: grid;
  gap: 12px;
  margin: 0 8px;
  padding: 12px 0 8px;
  border-top: 1px solid var(--frock-border);
}

.provider-settings label {
  display: grid;
  gap: 6px;
}

.provider-settings span,
.provider-settings small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.provider-settings input,
.provider-settings select {
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
  color: var(--frock-text);
  font-size: var(--frock-text-base);
}

.provider-settings__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
