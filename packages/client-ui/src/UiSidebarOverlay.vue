<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import UiIconButton from "./UiIconButton.vue";

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
  <!--
    The layer under the panel.

    A surface with no scrim read as a rendering glitch: it covered the sidebar
    and half the conversation, cut the composer's rounded pill clean in two,
    and left the chat behind it fully lit, so nothing on screen said which of
    the two was the live one. Dimming what the panel is over says it, and gives
    the pointer the dismissal every other overlay in the product has.

    It is a pointer shortcut, not a second control: the panel's own Close
    button and Escape are the announced ways out, so it stays out of the
    accessibility tree rather than becoming a duplicate "Close panel".

    And it is not transitioned. A scrim that fades out is a scrim that is still
    over the window while it fades; one whose leave never completed sat there
    for the rest of the session, swallowing every click on the Bot list
    underneath it. A layer that intercepts the pointer leaves the moment it
    stops meaning anything.
  -->
  <button
    v-if="open"
    type="button"
    class="ui-sidebar-overlay__scrim"
    tabindex="-1"
    aria-hidden="true"
    @click="emit('close')"
  />
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
        <UiIconButton
          data-surface-close
          icon="close"
          label="Close panel"
          @click="emit('close')"
        />
      </header>
      <div class="ui-sidebar-overlay__content">
        <slot />
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.ui-sidebar-overlay__scrim {
  position: absolute;
  z-index: var(--frock-layer-surface);
  inset: 0;
  border: 0;
  padding: 0;
  background: var(--frock-overlay-tint);
  cursor: pointer;
}

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
  min-height: var(--frock-titlebar-height);
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 0 18px 0 24px;
  border-bottom: 1px solid var(--frock-border);
}

.ui-sidebar-overlay__header h2 {
  overflow: hidden;
  margin: 0;
  font-family: var(--frock-font-display);
  font-size: var(--frock-text-2xl);
  font-weight: 400;
  letter-spacing: var(--frock-tracking-display);
  white-space: nowrap;
  text-overflow: ellipsis;
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
