<script setup lang="ts">
/**
 * One deep-linkable settings row or section.
 *
 * It gives its content a stable DOM id, offers a copy-link control, and
 * highlights itself when a link resolves to it. Two things can make it the
 * target: the shell announcing an anchor after it opened the surface, and the
 * document's own fragment at the moment this row mounts — a panel loads its
 * state asynchronously, so a row frequently appears *after* the link that
 * named it was handled, and polling for it from the shell would be the wrong
 * side of the seam.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import UiIconButton from "./UiIconButton.vue";
import {
  UI_ANCHOR_EVENT,
  UI_ANCHOR_HIGHLIGHT_MS,
  type UiAnchorEvent,
} from "./anchors.js";

const props = withDefaults(
  defineProps<{
    /** The fragment identifier, and this element's DOM id. */
    anchor: string;
    /** What the row is called; used for the copy control's accessible name. */
    label: string;
    /** The link the copy control puts on the clipboard. */
    href?: string;
    /** An `article` for a card, a `section` for a titled block. */
    as?: "div" | "section" | "article";
  }>(),
  { href: undefined, as: "div" },
);

/*
 * Two states, deliberately. `highlighted` is the flash and fades; `targeted`
 * records that a link resolved to this row and stays, so a reader who looks
 * away can still tell which row they were sent to — and so a test can assert
 * the link landed without racing the fade.
 */
const highlighted = ref(false);
const targeted = ref(false);
const copied = ref(false);
const root = ref<HTMLElement>();
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

function reveal(): void {
  targeted.value = true;
  highlighted.value = true;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlighted.value = false;
  }, UI_ANCHOR_HIGHLIGHT_MS);
  const element = root.value;
  if (!element?.scrollIntoView) return;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({
    behavior: reduced ? "auto" : "smooth",
    block: "nearest",
  });
}

function onAnnounced(event: Event): void {
  if ((event as UiAnchorEvent).detail === props.anchor) reveal();
}

onMounted(() => {
  window.addEventListener(UI_ANCHOR_EVENT, onAnnounced);
  const fragment = decodeURIComponent(
    window.location.hash.replace(/^#/u, "") || "",
  );
  if (fragment === props.anchor) reveal();
});

onBeforeUnmount(() => {
  window.removeEventListener(UI_ANCHOR_EVENT, onAnnounced);
  clearTimeout(highlightTimer);
  clearTimeout(copiedTimer);
});

async function copyLink(): Promise<void> {
  if (!props.href) return;
  const absolute = new URL(props.href, window.location.href).href;
  try {
    await navigator.clipboard.writeText(absolute);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, UI_ANCHOR_HIGHLIGHT_MS);
  } catch {
    // Clipboard access can be refused, and a refused copy is not a product
    // failure: the row is already addressable, and the User can read the link
    // off the address bar after following it once.
    copied.value = false;
  }
}
</script>

<template>
  <component
    :is="as"
    :id="anchor"
    ref="root"
    class="ui-anchor"
    :class="{ 'ui-anchor--target': highlighted }"
    :data-anchor-target="targeted ? 'true' : undefined"
  >
    <slot />
    <UiIconButton
      v-if="href"
      class="ui-anchor__copy"
      :icon="copied ? 'check' : 'link'"
      :label="copied ? `Copied link to ${label}` : `Copy link to ${label}`"
      size="sm"
      @click="copyLink"
    />
  </component>
</template>

<style scoped>
.ui-anchor {
  position: relative;
  border-radius: var(--frock-radius-control);
  scroll-margin-block: 12px;
  transition:
    background-color var(--frock-motion-panel),
    box-shadow var(--frock-motion-panel);
}

.ui-anchor--target {
  background: var(--frock-surface-accent-soft);
  box-shadow: 0 0 0 2px var(--frock-border-focus);
}

.ui-anchor__copy {
  position: absolute;
  top: 0;
  right: 0;
  opacity: 0;
  transition: opacity var(--frock-motion-fast);
}

.ui-anchor:hover .ui-anchor__copy,
.ui-anchor:focus-within .ui-anchor__copy,
.ui-anchor[data-anchor-target] .ui-anchor__copy {
  opacity: 1;
}

@media (hover: none) {
  .ui-anchor__copy {
    opacity: 1;
  }
}
</style>
