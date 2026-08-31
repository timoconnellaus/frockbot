<script setup lang="ts">
import UiIcon from "./UiIcon.vue";
import type { UiIconName } from "./icons.js";

/**
 * A square control that holds exactly one icon. The icon is centred by the
 * grid, not by line metrics, so it never drifts the way a text glyph does.
 * `label` is mandatory because the control has no visible text.
 */
withDefaults(
  defineProps<{
    label: string;
    icon?: UiIconName;
    type?: "button" | "submit" | "reset";
    /** ghost: no chrome until hover. outlined: hairline ring. primary: accent fill. */
    variant?: "ghost" | "outlined" | "primary";
    size?: "sm" | "md" | "lg";
    shape?: "round" | "square";
    disabled?: boolean;
    pressed?: boolean;
  }>(),
  {
    icon: undefined,
    type: "button",
    variant: "ghost",
    size: "md",
    shape: "round",
    disabled: false,
    pressed: undefined,
  },
);
</script>

<template>
  <button
    :type="type"
    class="ui-icon-button"
    :class="[
      `ui-icon-button--${variant}`,
      `ui-icon-button--${size}`,
      `ui-icon-button--${shape}`,
    ]"
    :disabled="disabled"
    :aria-label="label"
    :aria-pressed="pressed"
    :title="label"
  >
    <slot>
      <UiIcon v-if="icon" :name="icon" :size="size === 'sm' ? 'sm' : 'md'" />
    </slot>
  </button>
</template>

<style scoped>
.ui-icon-button {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  color: var(--frock-text-muted);
  background: transparent;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition:
    background-color var(--frock-motion-fast),
    border-color var(--frock-motion-fast),
    color var(--frock-motion-fast),
    transform var(--frock-motion-fast);
}

.ui-icon-button--sm {
  width: var(--frock-control-sm);
  height: var(--frock-control-sm);
}

.ui-icon-button--md {
  width: var(--frock-control-md);
  height: var(--frock-control-md);
}

.ui-icon-button--lg {
  width: var(--frock-control-lg);
  height: var(--frock-control-lg);
}

.ui-icon-button--round {
  border-radius: 999px;
}

.ui-icon-button--square {
  border-radius: var(--frock-radius-control);
}

.ui-icon-button--outlined {
  border-color: var(--frock-border);
  background: var(--frock-surface);
}

.ui-icon-button--primary {
  color: var(--frock-on-accent);
  background: var(--frock-action-primary);
}

.ui-icon-button--ghost:hover:not(:disabled),
.ui-icon-button--outlined:hover:not(:disabled) {
  color: var(--frock-text);
  background: var(--frock-fill-hover);
}

.ui-icon-button--primary:hover:not(:disabled) {
  background: var(--frock-action-primary-hover);
}

.ui-icon-button:active:not(:disabled) {
  transform: scale(0.94);
}

.ui-icon-button--ghost:active:not(:disabled),
.ui-icon-button--outlined:active:not(:disabled) {
  background: var(--frock-fill-pressed);
}

.ui-icon-button[aria-pressed="true"] {
  color: var(--frock-action-primary-hover);
  background: var(--frock-surface-accent);
}

.ui-icon-button:disabled {
  color: var(--frock-text-disabled);
  cursor: default;
}

.ui-icon-button--primary:disabled {
  background: var(--frock-surface-disabled);
}
</style>
