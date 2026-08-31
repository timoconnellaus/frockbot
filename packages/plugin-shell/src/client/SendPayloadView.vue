<script setup lang="ts">
/*
 * One user-facing send, drawn in the thread on the Bot's side.
 *
 * Read-only by design: a widget shows the question and its options but does
 * not answer it. Answering queues a normal chat Turn, which is a later slice,
 * and a control that looks live but is not would be worse than none.
 *
 * Anything this client cannot draw — a payload shape newer than this bundle,
 * or one the decoder refused — becomes a plain line saying so. A Turn's
 * history has to render on a client older than the Bot that produced it.
 */
import { UiMarkdown } from "@frockbot/client-ui";
import { computed } from "vue";
import { settingsLinkV1 } from "../settings-links.js";
import type { WebSendPayload } from "../shared.js";

const props = defineProps<{ send: WebSendPayload }>();

const payload = computed(() =>
  props.send.kind === "payload" ? props.send.payload : undefined,
);
const text = computed(() =>
  payload.value?.type === "text" ? payload.value.text : undefined,
);
const widget = computed(() =>
  payload.value?.type === "widget" ? payload.value.widget : undefined,
);
const attachment = computed(() =>
  payload.value?.type === "attachment" ? payload.value : undefined,
);
/**
 * The connect card. It carries no URL and never will: the Bot recorded a
 * pending decision, and only the User — in Settings, where the host authors
 * the link at the moment they press it — can complete one. So this draws the
 * request and points at the place the decision is made, and is deliberately
 * not a button that authorizes anything.
 */
const connectCard = computed(() =>
  payload.value?.type === "connect-card" ? payload.value : undefined,
);
const connectionsLink = settingsLinkV1({ anchor: "user-packages" });
const unsupported = computed(
  () => !text.value && !widget.value && !attachment.value && !connectCard.value,
);
</script>

<template>
  <div v-if="text" class="send-text"><UiMarkdown :text="text" /></div>

  <section v-else-if="widget" class="send-widget" aria-label="Question">
    <p class="send-widget-prompt">{{ widget.prompt }}</p>
    <p v-if="widget.helpText" class="send-widget-help">
      {{ widget.helpText }}
    </p>
    <ul class="send-widget-options">
      <li v-for="option in widget.options" :key="option">{{ option }}</li>
    </ul>
    <p v-if="widget.allowCustom" class="send-widget-help">
      Any other answer is accepted too.
    </p>
  </section>

  <section
    v-else-if="connectCard"
    class="send-connect-card"
    aria-label="Connection request"
  >
    <p class="send-connect-title">{{ connectCard.title }}</p>
    <p v-if="connectCard.body" class="send-connect-body">
      {{ connectCard.body }}
    </p>
    <p class="send-connect-help">
      Open Settings → Plugins to authorize it. Only you can complete this.
      <a :href="connectionsLink">{{ connectionsLink }}</a>
    </p>
  </section>

  <p v-else-if="attachment" class="send-attachment">
    <a :href="attachment.url" target="_blank" rel="noopener noreferrer">{{
      attachment.name ?? attachment.url
    }}</a>
  </p>

  <p v-else-if="unsupported" class="send-unsupported">
    This client cannot display that message.
  </p>
</template>

<style scoped>
/* An assistant-side bubble, shaped like the one the derived text uses. */
.send-text {
  width: max-content;
  max-width: 100%;
  border: 1px solid var(--frock-border);
  border-radius: 18px 18px 18px 6px;
  background: var(--frock-surface-subtle);
  padding: 10px 14px;
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  line-height: var(--frock-leading-normal);
  overflow-wrap: anywhere;
}

.send-widget {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 0.75rem 1rem;
}

.send-widget-prompt {
  margin: 0;
  color: var(--frock-text);
  font-weight: 600;
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-snug);
}

.send-widget-help {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.send-widget-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.send-connect-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 0.75rem 1rem;
}

.send-connect-title {
  margin: 0;
  color: var(--frock-text);
  font-weight: 600;
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-snug);
}

.send-connect-body {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.send-connect-help {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
  overflow-wrap: anywhere;
}

.send-widget-options li {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface);
  padding: 0.25rem 0.625rem;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.send-attachment,
.send-unsupported {
  margin: 0;
  font-size: var(--frock-text-sm);
}

.send-attachment a {
  color: var(--frock-accent-text);
}

.send-unsupported {
  color: var(--frock-text-muted);
  font-style: italic;
}
</style>
