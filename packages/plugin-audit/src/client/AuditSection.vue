<script setup lang="ts">
// The Bot's audit log: every audited effect it has performed, newest first.
//
// It renders durable state and decides nothing. In particular it never infers
// an outcome: an effect the durable event log cannot explain is shown as
// "Unknown" in the same place a success or a failure would be, because that is
// what the log says and hiding it would be the silent classification the
// reconciliation rule forbids. The same goes for truncation — a table trimmed
// to its retention bound says so above the rows rather than quietly answering
// with fewer.
import { UiAnchor, UiButton, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, watch } from "vue";
import {
  AUDIT_KINDS_V1,
  type AuditEntryV1,
  type AuditKindV1,
} from "../shared.js";
import { auditStateKey } from "./state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(auditStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Audit client services were not provided");
}
const web = providedWeb;
const audit = providedState;

const botId = computed(() => web.value.activeBotId);
const anchorHref = computed(() =>
  settingsLinkV1({ anchor: "bot-audit", botId: botId.value }),
);
const kinds = AUDIT_KINDS_V1;

watch(
  botId,
  (id) => {
    if (!id) return;
    if (audit.value.botId !== id || !audit.value.loaded) {
      void audit.value.load(id);
    }
  },
  { immediate: true },
);

function selectKind(kind: AuditKindV1 | undefined): void {
  const id = botId.value;
  if (!id) return;
  void audit.value.load(id, {
    ...audit.value.filters,
    ...(kind === undefined ? { kind: undefined } : { kind }),
  });
}

/** Where the effect ran, in words rather than in the wire shape. */
function target(entry: AuditEntryV1): string {
  if (entry.target === "computer") return "This Computer";
  if (entry.target.startsWith("machine:")) {
    return `Machine ${entry.target.slice("machine:".length)}`;
  }
  return entry.target.slice("remote:".length);
}

function when(entry: AuditEntryV1): string {
  const parsed = Date.parse(entry.at);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : entry.at;
}
</script>

<template>
  <UiAnchor
    as="section"
    anchor="bot-audit"
    label="Audit log"
    :href="anchorHref"
    class="audit"
  >
    <header class="audit__header">
      <span class="audit__icon" aria-hidden="true"
        ><UiIcon name="history"
      /></span>
      <span class="audit__intro">
        <strong>Audit log</strong>
        <small>
          Every shell command, browser action, remote tool call and file write
          this Bot has made. Command details aren't stored.
        </small>
      </span>
      <UiButton
        type="button"
        :disabled="!botId || audit.busy"
        @click="botId && audit.rebuild(botId)"
      >
        Rebuild
      </UiButton>
    </header>

    <p v-if="audit.error" class="audit__error" role="alert">
      {{ audit.error }}
    </p>

    <p
      v-if="audit.indexState === 'truncated'"
      class="audit__banner"
      role="status"
    >
      Older activity has been trimmed. Rebuild to restore what's still
      available.
    </p>
    <p
      v-else-if="audit.indexState === 'rebuilding'"
      class="audit__banner"
      role="status"
    >
      Rebuilding. What's shown may be incomplete until it finishes.
    </p>

    <div v-if="audit.receipt" class="audit-receipt">
      <strong>
        Rebuilt {{ audit.receipt.entries }} entries across
        {{ audit.receipt.bots }} Bots
      </strong>
      <small>
        {{ audit.receipt.unknownOutcomes }} with an outcome this log can't
        explain, and {{ audit.receipt.hostJournalDiscrepancies }} action(s) the
        computer reported that this log can't match to anything the Bot did.
      </small>
      <div class="audit-receipt__actions">
        <UiButton type="button" @click="audit.dismissReceipt()">
          Done
        </UiButton>
      </div>
    </div>

    <div class="audit__chips" role="group" aria-label="Filter by kind">
      <button
        type="button"
        class="audit-chip"
        :data-active="audit.filters.kind === undefined ? 'yes' : 'no'"
        @click="selectKind(undefined)"
      >
        All
      </button>
      <button
        v-for="kind in kinds"
        :key="kind"
        type="button"
        class="audit-chip"
        :data-active="audit.filters.kind === kind ? 'yes' : 'no'"
        @click="selectKind(kind)"
      >
        {{ kind }}
      </button>
    </div>

    <p v-if="audit.loaded && audit.entries.length === 0" class="audit__empty">
      Nothing here yet. Only actions get logged, not conversation.
    </p>

    <ol v-else class="audit__rows">
      <li
        v-for="entry in audit.entries"
        :key="`${entry.runId}:${entry.occurrenceId}`"
        class="audit-row"
      >
        <span class="audit-row__time">{{ when(entry) }}</span>
        <span class="audit-row__kind" :data-kind="entry.kind">{{
          entry.kind
        }}</span>
        <span class="audit-row__target">{{ target(entry) }}</span>
        <span class="audit-row__preview" :title="entry.toolName">{{
          entry.preview
        }}</span>
        <span class="audit-row__outcome" :data-outcome="entry.outcome">{{
          entry.outcome
        }}</span>
      </li>
    </ol>

    <div v-if="audit.nextCursor" class="audit__more">
      <UiButton
        type="button"
        :disabled="audit.busy"
        @click="botId && audit.loadMore(botId)"
      >
        Load more
      </UiButton>
      <small>{{ audit.entries.length }} of {{ audit.total }}</small>
    </div>
  </UiAnchor>
</template>

<style scoped>
.audit {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.audit__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.audit__icon {
  display: grid;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: var(--frock-action-primary);
  background: var(--frock-surface);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}

.audit__intro {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.audit__intro strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.audit__intro small,
.audit__empty,
.audit__banner {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.audit__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.audit__banner {
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 8px 10px;
  background: var(--frock-surface-subtle);
}

.audit-receipt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 12px;
  background: var(--frock-surface-subtle);
}

.audit-receipt strong {
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.audit-receipt small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.audit-receipt__actions {
  display: flex;
  gap: 8px;
}

.audit__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.audit-chip {
  border: 1px solid var(--frock-border);
  border-radius: 999px;
  padding: 3px 10px;
  color: var(--frock-text-muted);
  background: var(--frock-surface);
  cursor: pointer;
  font-size: var(--frock-text-sm);
}

.audit-chip[data-active="yes"] {
  color: var(--frock-action-primary);
  border-color: var(--frock-action-primary);
}

.audit__rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.audit-row {
  display: grid;
  align-items: baseline;
  gap: 8px;
  grid-template-columns: auto auto auto 1fr auto;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 6px 10px;
  background: var(--frock-surface-subtle);
  font-size: var(--frock-text-sm);
}

.audit-row__time,
.audit-row__target {
  color: var(--frock-text-muted);
  white-space: nowrap;
}

.audit-row__kind {
  border: 1px solid var(--frock-border);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--frock-text);
}

.audit-row__preview {
  overflow: hidden;
  color: var(--frock-text);
  font-family: var(--frock-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-row__outcome {
  color: var(--frock-text-muted);
  white-space: nowrap;
}

.audit-row__outcome[data-outcome="error"],
.audit-row__outcome[data-outcome="refused"] {
  color: var(--frock-danger-text);
}

.audit__more {
  display: flex;
  align-items: center;
  gap: 8px;
}

.audit__more small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
</style>
