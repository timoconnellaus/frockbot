<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: "button" | "submit" | "reset";
    variant?: "primary" | "secondary" | "danger" | "ghost";
    disabled?: boolean;
  }>(),
  { type: "button", variant: "secondary", disabled: false },
);
</script>

<template>
  <button
    :type="type"
    class="ui-button"
    :class="`ui-button--${variant}`"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  min-height: 36px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
  background: transparent;
  font-size: var(--frock-text-base);
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--frock-motion-fast),
    border-color var(--frock-motion-fast),
    color var(--frock-motion-fast),
    transform var(--frock-motion-fast);
}

.ui-button:active:not(:disabled) {
  transform: scale(0.97);
}

.ui-button--primary {
  color: var(--frock-on-accent);
  background: var(--frock-action-primary);
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--frock-action-primary-hover);
}

.ui-button--secondary {
  border-color: var(--frock-border);
  background: var(--frock-surface-raised);
}

.ui-button--secondary:hover:not(:disabled),
.ui-button--ghost:hover:not(:disabled) {
  background: var(--frock-surface-subtle);
}

.ui-button--danger {
  color: var(--frock-danger-text);
  background: var(--frock-danger-surface);
}

.ui-button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
