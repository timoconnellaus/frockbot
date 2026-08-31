<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "./markdown.js";

/**
 * Renders Markdown text. The HTML comes from `renderMarkdown`, which escapes
 * every author tag, so `v-html` here injects only markup the parser produced.
 */
const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="ui-markdown" v-html="html" />
</template>

<style scoped>
.ui-markdown {
  overflow-wrap: anywhere;
  /* The bubble sets pre-wrap for plain text; rendered Markdown owns its own
     whitespace, so it opts back out. */
  white-space: normal;
}

.ui-markdown :deep(> :first-child) {
  margin-top: 0;
}

.ui-markdown :deep(> :last-child) {
  margin-bottom: 0;
}

.ui-markdown :deep(p) {
  margin: 0 0 8px;
}

.ui-markdown :deep(ul),
.ui-markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.ui-markdown :deep(li) {
  margin: 2px 0;
}

.ui-markdown :deep(li > ul),
.ui-markdown :deep(li > ol) {
  margin-bottom: 0;
}

.ui-markdown :deep(h1),
.ui-markdown :deep(h2),
.ui-markdown :deep(h3),
.ui-markdown :deep(h4) {
  margin: 14px 0 6px;
  font-weight: 600;
  line-height: var(--frock-leading-snug);
}

.ui-markdown :deep(h1) {
  font-size: var(--frock-text-xl);
  letter-spacing: var(--frock-tracking-display);
}

.ui-markdown :deep(h2) {
  font-size: var(--frock-text-lg);
}

.ui-markdown :deep(h3) {
  font-size: var(--frock-text-md);
}

.ui-markdown :deep(h4) {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
}

.ui-markdown :deep(strong) {
  font-weight: 650;
}

.ui-markdown :deep(a) {
  color: var(--frock-action-primary-hover);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ui-markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--frock-fill-hover);
  font-family: var(--frock-font-mono);
  font-size: var(--frock-text-sm);
}

.ui-markdown :deep(pre) {
  overflow-x: auto;
  margin: 0 0 8px;
  padding: 10px 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface);
  scrollbar-color: var(--frock-scrollbar) transparent;
  scrollbar-width: thin;
}

.ui-markdown :deep(pre code) {
  display: block;
  padding: 0;
  border-radius: 0;
  background: transparent;
  line-height: var(--frock-leading-snug);
  white-space: pre;
}

.ui-markdown :deep(blockquote) {
  margin: 0 0 8px;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--frock-border-strong);
  color: var(--frock-text-muted);
}

.ui-markdown :deep(table) {
  display: block;
  overflow-x: auto;
  max-width: 100%;
  margin: 0 0 8px;
  border-collapse: collapse;
  font-size: var(--frock-text-sm);
}

.ui-markdown :deep(th),
.ui-markdown :deep(td) {
  padding: 5px 9px;
  border: 1px solid var(--frock-border);
  text-align: left;
}

.ui-markdown :deep(th) {
  background: var(--frock-surface);
  font-weight: 600;
}

.ui-markdown :deep(hr) {
  margin: 12px 0;
  border: 0;
  border-top: 1px solid var(--frock-border);
}

.ui-markdown :deep(img) {
  max-width: 100%;
  border-radius: var(--frock-radius-control);
}
</style>
