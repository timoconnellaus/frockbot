<script setup lang="ts">
/**
 * The one shape a confirmation takes: a short question, the sentence that
 * says what happens, and the two answers.
 *
 * Confirmations used to borrow whatever frame the surface already had — in
 * Flock's case the Create-a-Bot dialog, a 660x520 two-column frame built to
 * hold a sheep and a wardrobe. Two sentences in the narrow column of that
 * frame wrapped six times and left a quarter of a page of nothing above the
 * buttons. A question this small owns its own frame: it is as wide as a
 * sentence wants to be and as tall as its content, so nothing on it is
 * stretched to fill a box that was measured for something else.
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import UiButton from "./UiButton.vue";
import { dialogFocusWrapTarget } from "./dialog-focus.js";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The small line above the question, naming the act. */
    eyebrow?: string;
    title: string;
    /** What the confirming button says — always a verb, never "OK". */
    confirmLabel: string;
    cancelLabel?: string;
    /** Destructive answers are red; everything else is the accent. */
    tone?: "primary" | "danger";
    /** A refusal from the command this dialog sent, shown in place. */
    error?: string;
    busy?: boolean;
  }>(),
  { cancelLabel: "Cancel", tone: "primary", busy: false },
);
const emit = defineEmits<{ cancel: []; confirm: [] }>();

const dialog = ref<HTMLElement>();
const cancelButton = ref<InstanceType<typeof UiButton>>();
let restoreFocus: HTMLElement | undefined;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * Cancel takes the focus, not the confirming button. The dialog is a question
 * and the safe answer is the one a stray Enter should give — which matters
 * most for exactly the dialog that cannot be undone.
 */
watch(
  () => props.open,
  async (open, previous) => {
    if (open && !previous) {
      restoreFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      await nextTick();
      const target =
        (cancelButton.value?.$el as HTMLElement | undefined) ??
        dialog.value?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    } else if (!open && previous) {
      restoreFocus?.focus();
      restoreFocus = undefined;
    }
  },
  { flush: "post" },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("cancel");
    return;
  }
  if (event.key !== "Tab" || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const target = dialogFocusWrapTarget(
    controls,
    document.activeElement as HTMLElement | null,
    event.shiftKey,
  );
  if (!target) return;
  event.preventDefault();
  target.focus();
}

onBeforeUnmount(() => restoreFocus?.focus());
</script>

<template>
  <div v-if="open" class="ui-confirm-backdrop" @click.self="emit('cancel')">
    <section
      ref="dialog"
      class="ui-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ui-confirm-title"
      aria-describedby="ui-confirm-body"
      @keydown="onKeydown"
    >
      <span v-if="eyebrow" class="ui-confirm__eyebrow">{{ eyebrow }}</span>
      <h1 id="ui-confirm-title" class="ui-confirm__title">{{ title }}</h1>
      <div id="ui-confirm-body" class="ui-confirm__body"><slot /></div>
      <p
        v-if="error"
        class="ui-confirm__error"
        role="alert"
        aria-live="assertive"
      >
        {{ error }}
      </p>
      <div class="ui-confirm__actions">
        <UiButton ref="cancelButton" @click="emit('cancel')">
          {{ cancelLabel }}
        </UiButton>
        <UiButton
          :variant="tone === 'danger' ? 'danger' : 'primary'"
          :class="tone === 'danger' ? 'ui-confirm__destructive' : undefined"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </UiButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ui-confirm-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--frock-overlay-tint);
  backdrop-filter: blur(2px);
  animation: frock-fade-in var(--frock-motion-fast) both;
}

.ui-confirm {
  /*
   * A sentence, not a page. The width is the measure two lines of body copy
   * read well at; the height is whatever the copy needs.
   */
  width: min(420px, 100%);
  padding: 24px;
  border: 1px solid var(--frock-overlay-border);
  border-radius: 20px;
  background: var(--frock-surface);
  color: var(--frock-text);
  box-shadow: var(--frock-shadow-dialog);
  animation: frock-scale-in var(--frock-motion-enter) both;
}

.ui-confirm__eyebrow {
  color: var(--frock-action-primary-hover);
  font-size: var(--frock-text-xs);
  font-weight: 800;
  letter-spacing: var(--frock-tracking-eyebrow);
  text-transform: uppercase;
}

.ui-confirm__title {
  margin: 6px 0 0;
  font-family: var(--frock-font-display);
  font-size: var(--frock-text-2xl);
  font-weight: 400;
  letter-spacing: var(--frock-tracking-display);
}

.ui-confirm__body {
  margin-top: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-normal);
}

.ui-confirm__body :slotted(p) {
  margin: 0;
}

.ui-confirm__error {
  margin: 12px 0 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-normal);
}

.ui-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

/*
 * The destructive answer is a filled red button rather than the tinted one
 * `UiButton`'s danger variant draws for inline rows: this is the one press in
 * the product that cannot be undone, and it reads as the primary answer to the
 * question the dialog asked.
 */
.ui-confirm__destructive {
  color: var(--frock-on-accent);
  background: var(--frock-danger-strong);
}

.ui-confirm__destructive:hover:not(:disabled) {
  background: var(--frock-danger-text);
}
</style>
