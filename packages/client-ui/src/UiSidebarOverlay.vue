<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
}>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
let restoreFocus: HTMLElement | undefined;

watch(
  () => props.open,
  async (open, previous) => {
    if (open && !previous) {
      restoreFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      await nextTick();
      panel.value?.querySelector<HTMLElement>("[data-surface-close]")?.focus();
    } else if (!open && previous) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  },
  { flush: "post" },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  emit("close");
}

onBeforeUnmount(() => restoreFocus?.focus());
</script>

<template>
  <Transition name="ui-surface">
    <aside
      v-if="open"
      ref="panel"
      class="ui-sidebar-overlay"
      role="region"
      aria-labelledby="ui-sidebar-overlay-title"
      @keydown="onKeydown"
    >
      <header class="ui-sidebar-overlay__header">
        <h2 id="ui-sidebar-overlay-title">{{ title }}</h2>
        <button
          data-surface-close
          type="button"
          aria-label="Close panel"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="ui-sidebar-overlay__content">
        <slot />
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.ui-sidebar-overlay {
  position: absolute;
  z-index: var(--frock-layer-surface);
  inset: 0 auto 0 0;
  display: flex;
  width: min(var(--frock-settings-width), 100vw);
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--frock-border);
  color: var(--frock-text);
  background: var(--frock-surface);
  box-shadow: var(--frock-shadow-panel);
}

.ui-sidebar-overlay__header {
  display: grid;
  min-height: 64px;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  gap: 16px;
  padding: 0 18px 0 24px;
  border-bottom: 1px solid var(--frock-border);
}

.ui-sidebar-overlay__header h2 {
  margin: 0;
  font-family: var(--frock-font-display);
  font-size: var(--frock-font-title);
  letter-spacing: -0.035em;
}

.ui-sidebar-overlay__header button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  padding: 0;
  border-radius: 50%;
  color: var(--frock-text-muted);
  background: transparent;
  font-size: 24px;
  cursor: pointer;
}

.ui-sidebar-overlay__header button:hover {
  color: var(--frock-text);
  background: var(--frock-surface-subtle);
}

.ui-sidebar-overlay__content {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scrollbar-color: var(--frock-scrollbar) transparent;
  scrollbar-width: thin;
}

.ui-surface-enter-active,
.ui-surface-leave-active {
  transition:
    transform var(--frock-motion-panel),
    opacity var(--frock-motion-panel);
}

.ui-surface-enter-from,
.ui-surface-leave-to {
  opacity: 0;
  transform: translateX(-18px);
}

@media (prefers-reduced-motion: reduce) {
  .ui-surface-enter-active,
  .ui-surface-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
