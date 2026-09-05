<script setup lang="ts">
import { UiButton, UiField } from "@frockbot/client-ui";
import type { Json, SettingsFrame } from "@frockbot/protocol-schemas";
import { ref } from "vue";
const props = defineProps<{
  section: SettingsFrame["sections"][number];
  busy: boolean;
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
function change(id: string, value: Json) {
  values.value[id] = value;
  if (!dirty.value.includes(id)) dirty.value.push(id);
}
function input(event: Event) {
  return (event.target as HTMLInputElement).value;
}
function save() {
  const ids =
    props.section.id === "profile" ? Object.keys(values.value) : dirty.value;
  const unset = ids.filter(
    (id) =>
      props.section.id.startsWith("package.") && values.value[id] === null,
  );
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
      <input
        v-if="field.kind === 'boolean'"
        type="checkbox"
        :checked="values[field.id] === true"
        :disabled="busy || !field.editable"
        @change="change(field.id, ($event.target as HTMLInputElement).checked)"
      />
      <select
        v-else-if="field.kind === 'select'"
        :value="JSON.stringify(values[field.id])"
        :disabled="busy || !field.editable"
        @change="change(field.id, JSON.parse(input($event)))"
      >
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
        :value="values[field.id] ?? ''"
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
    </UiField>
    <div
      v-if="section.fields.some((field) => field.editable)"
      class="frame-actions"
    >
      <UiButton
        variant="primary"
        type="submit"
        :disabled="busy || dirty.length === 0"
        >Save changes</UiButton
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
