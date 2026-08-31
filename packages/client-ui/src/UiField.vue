<script setup lang="ts">
defineProps<{
  label: string;
  hint?: string;
}>();
</script>

<template>
  <label class="ui-field">
    <span class="ui-field__label">
      {{ label }} <small v-if="hint">{{ hint }}</small>
    </span>
    <slot />
  </label>
</template>

<style scoped>
.ui-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  font-weight: 700;
}

.ui-field__label small {
  color: var(--frock-text-subtle);
  font-weight: 500;
}

.ui-field :deep(input),
.ui-field :deep(textarea),
.ui-field :deep(select) {
  width: 100%;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  outline: none;
  padding: 10px 12px;
  color: var(--frock-text);
  background: var(--frock-surface-raised);
  font-size: var(--frock-text-md);
  transition:
    border-color var(--frock-motion-fast),
    box-shadow var(--frock-motion-fast);
}

.ui-field :deep(input:focus),
.ui-field :deep(textarea:focus),
.ui-field :deep(select:focus) {
  border-color: var(--frock-border-focus);
  box-shadow: 0 0 0 3px var(--frock-focus-ring);
}

.ui-field :deep(textarea) {
  resize: vertical;
  line-height: var(--frock-leading-normal);
}
</style>
