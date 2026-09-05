<script setup lang="ts">
import { UiButton, UiField } from "@frockbot/client-ui";
import type { Json, SettingsFrame } from "@frockbot/protocol-schemas";
import { ref } from "vue";
import SettingsModelPicker from "./SettingsModelPicker.vue";
const props = defineProps<{
  section: SettingsFrame["sections"][number];
  busy: boolean;
  revision: number;
}>();
const emit = defineEmits<{
  save: [id: string, values: Record<string, Json>, unset: string[]];
  manage: [];
}>();
const values = ref<Record<string, Json>>(
  Object.fromEntries(
    props.section.fields.map((field) => [field.id, field.value]),
  ),
);
const dirty = ref<string[]>([]);
const reset = ref<string[]>([]);
const labels = ref<Record<string, string>>({});
function useDefault(id: string) {
  if (!dirty.value.includes(id)) dirty.value.push(id);
  if (!reset.value.includes(id)) reset.value.push(id);
}
function isDefault(id: string) {
  return (
    reset.value.includes(id) ||
    (!dirty.value.includes(id) &&
      props.section.fields.find((f) => f.id === id)?.isSet === false)
  );
}
function change(id: string, value: Json) {
  values.value[id] = value;
  reset.value = reset.value.filter((key) => key !== id);
  if (!dirty.value.includes(id)) dirty.value.push(id);
}
function input(event: Event) {
  return (event.target as HTMLInputElement).value;
}
function save() {
  const ids =
    props.section.id === "profile" ? Object.keys(values.value) : dirty.value;
  const unset = ids.filter((id) => reset.value.includes(id));
  emit(
    "save",
    props.section.id,
    Object.fromEntries(
      ids
        .filter((id) => !unset.includes(id))
        .map((id) => [id, values.value[id]!]),
    ),
    unset,
  );
}
</script>
<template>
  <form class="frame-section" @submit.prevent="save">
    <h3>{{ section.label }}</h3>
    <p v-if="section.failure" role="alert">{{ section.failure }}</p>
    <UiField
      v-for="field in section.fields"
      :key="field.id"
      :label="field.label"
      :hint="field.hint"
    >
      <SettingsModelPicker
        v-if="field.choiceSource === 'account-models'"
        :revision="revision"
        :value="values[field.id]!"
        :label="
          labels[field.id] ??
          field.choices?.find(
            (c) => JSON.stringify(c.value) === JSON.stringify(values[field.id]),
          )?.label ??
          'Choose a model'
        "
        :disabled="busy || !field.editable"
        @choose="
          (choice) => {
            change(field.id, choice.value);
            labels[field.id] = choice.label;
          }
        "
      />
      <select
        v-else-if="field.kind === 'boolean' && field.canReset"
        :value="
          isDefault(field.id)
            ? 'default'
            : values[field.id] === true
              ? 'on'
              : 'off'
        "
        :disabled="busy || !field.editable"
        @change="
          input($event) === 'default'
            ? useDefault(field.id)
            : change(field.id, input($event) === 'on')
        "
      >
        <option value="default">Use default</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
      <input
        v-else-if="field.kind === 'boolean'"
        type="checkbox"
        :checked="values[field.id] === true"
        :disabled="busy || !field.editable"
        @change="change(field.id, ($event.target as HTMLInputElement).checked)"
      />
      <select
        v-else-if="field.kind === 'select'"
        :value="
          isDefault(field.id) ? '__default__' : JSON.stringify(values[field.id])
        "
        :disabled="busy || !field.editable"
        @change="
          input($event) === '__default__'
            ? useDefault(field.id)
            : change(field.id, JSON.parse(input($event)))
        "
      >
        <option v-if="field.canReset" value="__default__">Use default</option>
        <option
          v-for="choice in field.choices"
          :key="JSON.stringify(choice.value)"
          :value="JSON.stringify(choice.value)"
        >
          {{ choice.label }}
        </option>
      </select>
      <input
        v-else
        :type="
          field.kind === 'number'
            ? 'number'
            : field.id === 'email'
              ? 'email'
              : 'text'
        "
        :value="isDefault(field.id) ? '' : (values[field.id] ?? '')"
        :disabled="busy || !field.editable"
        :min="field.minimum"
        :max="field.maximum"
        :maxlength="field.maxLength"
        :required="field.required"
        @input="
          change(
            field.id,
            field.kind === 'number'
              ? input($event) === ''
                ? null
                : Number(input($event))
              : input($event),
          )
        "
      />
      <div
        v-if="
          field.canReset && field.kind !== 'select' && field.kind !== 'boolean'
        "
        class="field-default"
      >
        <span v-if="isDefault(field.id)">Using default</span>
        <UiButton
          v-else
          type="button"
          :disabled="busy || !field.editable"
          @click="useDefault(field.id)"
          >Use default</UiButton
        >
      </div>
    </UiField>
    <div
      v-if="section.fields.some((field) => field.editable)"
      class="frame-actions"
    >
      <UiButton
        variant="primary"
        type="submit"
        :disabled="busy || dirty.length === 0"
        >{{
          section.id === "profile" ? "Save profile" : "Save changes"
        }}</UiButton
      >
    </div>
    <UiButton
      v-for="action in section.actions"
      :key="action.kind"
      type="button"
      :disabled="busy"
      @click="
        action.kind === 'manage-provider'
          ? emit('manage')
          : emit('save', section.id, {}, [])
      "
      >{{ action.label }}</UiButton
    >
  </form>
</template>
<style scoped>
.frame-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 0;
  border-bottom: 1px solid var(--frock-border);
  min-width: 0;
}
h3 {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
}
p {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
.frame-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
