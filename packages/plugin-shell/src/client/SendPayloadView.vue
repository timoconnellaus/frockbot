<script setup lang="ts">
/*
 * One user-facing send, drawn in the thread on the Bot's side.
 *
 * Read-only by design, with one exception. A widget shows the question and its
 * options but does not answer it: answering queues a normal chat Turn, which is
 * a later slice, and a control that looks live but is not would be worse than
 * none. An approval card *is* live, because its answer is not a Turn — it is a
 * durable decision recorded against a record the Bot Durable Object already
 * holds, and the buttons submit exactly that command.
 *
 * The card renders the decision the backend reports, never the click: a card
 * answered on another device, or expired by the alarm, shows what was actually
 * recorded.
 *
 * Anything this client cannot draw — a payload shape newer than this bundle,
 * or one the decoder refused — becomes a plain line saying so. A Turn's
 * history has to render on a client older than the Bot that produced it.
 */
import { UiButton, UiMarkdown } from "@frockbot/client-ui";
import { computed, inject, ref } from "vue";
import { settingsLinkV1 } from "../settings-links.js";
import { frockBotWebDataKey, type WebSendPayload } from "../shared.js";

const props = defineProps<{ send: WebSendPayload }>();

const web = inject(frockBotWebDataKey);
const deciding = ref(false);

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
const approval = computed(() =>
  payload.value?.type === "approval" ? payload.value : undefined,
);

/** What the backend says about this card, when it has been read. */
const record = computed(() =>
  approval.value
    ? web?.value.approvals.find(
        (candidate) => candidate.approvalId === approval.value?.approvalId,
      )
    : undefined,
);

const decision = computed(() => record.value?.decision ?? "pending");

const decided = computed(() =>
  decision.value === "approved"
    ? "You approved this."
    : decision.value === "denied"
      ? "You denied this."
      : decision.value === "expired"
        ? "This expired before anyone answered."
        : undefined,
);

const expiry = computed(() => {
  const at = record.value?.expiresAt;
  if (!at || decision.value !== "pending") return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : `Expires ${parsed.toLocaleString()}`;
});

async function decide(next: "approved" | "denied"): Promise<void> {
  if (!web || !approval.value || deciding.value) return;
  deciding.value = true;
  try {
    await web.value.decideApproval(approval.value.approvalId, next);
  } finally {
    deciding.value = false;
  }
}

const unsupported = computed(
  () => !text.value && !widget.value && !attachment.value && !approval.value,
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

  <section
    v-else-if="approval"
    class="send-approval"
    :class="`send-approval--${decision}`"
    aria-label="Approval request"
  >
    <header class="send-approval-head">
      <span class="send-approval-risk" :class="`risk-${approval.risk}`">{{
        approval.risk
      }}</span>
      <span class="send-approval-label">Needs your approval</span>
    </header>
    <p class="send-approval-action">{{ approval.action }}</p>
    <p v-if="approval.rationale" class="send-approval-rationale">
      {{ approval.rationale }}
    </p>
    <p v-if="decided" class="send-approval-decided">{{ decided }}</p>
    <div v-else class="send-approval-actions">
      <UiButton :disabled="deciding || !web" @click="decide('approved')"
        >Approve</UiButton
      >
      <UiButton
        variant="ghost"
        :disabled="deciding || !web"
        @click="decide('denied')"
        >Deny</UiButton
      >
    </div>
    <p v-if="expiry" class="send-approval-expiry">{{ expiry }}</p>
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

.send-approval {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  padding: 0.75rem 1rem;
}

.send-approval-head {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.send-approval-risk {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-control);
  padding: 0.125rem 0.5rem;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
  text-transform: uppercase;
}

.send-approval-risk.risk-high {
  border-color: var(--frock-danger-border);
  color: var(--frock-danger-text);
}

.send-approval-label {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.send-approval-action {
  margin: 0;
  color: var(--frock-text);
  font-weight: 600;
  font-size: var(--frock-text-base);
  line-height: var(--frock-leading-snug);
}

.send-approval-rationale,
.send-approval-decided,
.send-approval-expiry {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  line-height: var(--frock-leading-normal);
}

.send-approval-actions {
  display: flex;
  gap: 0.5rem;
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
