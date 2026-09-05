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

/*
 * Escape closes the panel wherever the focus is.
 *
 * A handler bound to the panel element only hears the key while the focus is
 * inside it, and the focus leaves the moment the User clicks the conversation
 * behind the panel or the browser hands it to the document body. The window is
 * where "close this" has to be heard, so the key is a real way out rather than
 * one that works only immediately after the panel opens.
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (!props.open) return;
  event.preventDefault();
  emit("close");
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", onWindowKeydown);
  onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKeydown));
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

    The scrim is a control, not decoration. A dimmed layer that swallows a
    click without doing anything is the thing every User tries first and the
    thing this panel used to ignore; clicking it now closes the panel, which is
    what the dimming has been promising all along. The workspace under it is
    `inert` while the panel is open, so the pointer, the Tab key and the
    accessibility tree all agree about which of the two layers is live. That
    inert background is what makes the panel modal in practice; the panel
    itself stays a region rather than claiming `aria-modal`, which would hide
    everything else from assistive technology including the surfaces these
    panels legitimately open over.

    It is a pointer shortcut and not a second exit in the accessibility tree:
    the header's Close button is that exit, and two controls with one name
    would only make the panel harder to read aloud.

    It is a `v-if` rather than a transition for the same reason a fade would be
    wrong: an element that outlives its panel is one nobody can see and
    everybody's clicks land on.
  -->
  <button
    v-if="open"
    type="button"
    class="ui-sidebar-overlay__scrim"
    data-surface-scrim
    tabindex="-1"
    aria-hidden="true"
    @click="emit('close')"
  ></button>
  <Transition name="ui-surface">
    <aside
      v-if="open"
      ref="panel"
      class="ui-sidebar-overlay"
      role="region"
      aria-labelledby="ui-sidebar-overlay-title"
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
  padding: 0;
  border: 0;
  background: var(--frock-overlay-tint);
  cursor: default;
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
