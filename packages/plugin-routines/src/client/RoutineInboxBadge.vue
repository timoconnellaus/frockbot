<script setup lang="ts">
// The completion inbox, in the shell header.
//
// A Routine firing cannot speak to the user: it has no `send_to_user`, and its
// Turn is filtered out of the visible transcript. So the only place a
// completion becomes visible is here — a count of what has not been read, and a
// drawer that reads it. Acknowledging is a command, never a side effect of
// opening the drawer, so a glance does not clear the badge.
import { UiButton, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, ref, watch } from "vue";
import { routinesStateKey } from "./state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(routinesStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Routines client services were not provided");
}
const web = providedWeb;
const routines = providedState;

const open = ref(false);
const botId = computed(() => web.value.activeBotId);
const count = computed(() => routines.value.unacknowledged);
const badge = computed(() => (count.value > 99 ? "99+" : String(count.value)));

watch(
  botId,
  (id) => {
    open.value = false;
    if (id) void routines.value.loadInbox(id);
  },
  { immediate: true },
);

function toggle(): void {
  open.value = !open.value;
  if (open.value && botId.value) void routines.value.loadInbox(botId.value);
}

function acknowledge(entryIds: string[]): void {
  if (!botId.value) return;
  void routines.value.acknowledgeInbox(botId.value, entryIds);
}
</script>

<template>
  <div v-if="botId" class="routine-inbox">
    <button
      type="button"
      class="routine-inbox__trigger"
      :aria-expanded="open"
      :title="`Routine completions${count > 0 ? ` (${badge} unread)` : ''}`"
      @click="toggle"
    >
      <UiIcon name="history" />
      <span v-if="count > 0" class="routine-inbox__badge">{{ badge }}</span>
    </button>

    <div v-if="open" class="routine-inbox__drawer">
      <header class="routine-inbox__header">
        <h2>Routine completions</h2>
        <UiButton
          v-if="count > 0"
          variant="ghost"
          :disabled="routines.busy"
          @click="acknowledge([])"
          >Mark all read</UiButton
        >
      </header>
      <p v-if="routines.inbox.length === 0" class="routine-inbox__empty">
        Nothing has been left here. A Routine that finishes lands its message in
        this drawer rather than in the conversation.
      </p>
      <ul v-else class="routine-inbox__list">
        <li
          v-for="entry in routines.inbox"
          :key="entry.entryId"
          :class="{ 'routine-inbox__item--read': entry.acknowledged }"
          class="routine-inbox__item"
        >
          <p class="routine-inbox__attribution">{{ entry.attribution }}</p>
          <p class="routine-inbox__text">{{ entry.text }}</p>
          <footer class="routine-inbox__meta">
            <span>{{ entry.createdAt }}</span>
            <UiButton
              v-if="!entry.acknowledged"
              variant="ghost"
              :disabled="routines.busy"
              @click="acknowledge([entry.entryId])"
              >Mark read</UiButton
            >
          </footer>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.routine-inbox {
  position: relative;
}

.routine-inbox__trigger {
  position: relative;
  display: grid;
  width: var(--frock-avatar-sm);
  height: var(--frock-avatar-sm);
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: var(--frock-text-muted);
  background: transparent;
  cursor: pointer;
}

.routine-inbox__trigger:hover {
  color: var(--frock-text);
  background: var(--frock-surface);
}

.routine-inbox__badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  color: var(--frock-on-accent);
  background: var(--frock-action-primary);
  font-size: var(--frock-text-xs);
  line-height: 16px;
  text-align: center;
}

.routine-inbox__drawer {
  position: absolute;
  z-index: 20;
  top: calc(100% + 8px);
  right: 0;
  display: flex;
  width: 340px;
  max-height: 60vh;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 12px;
  border-radius: 12px;
  background: var(--frock-surface);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}

.routine-inbox__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.routine-inbox__header h2 {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.routine-inbox__empty {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-inbox__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.routine-inbox__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  background: var(--frock-surface-raised);
}

.routine-inbox__item--read {
  opacity: 0.6;
}

.routine-inbox__attribution {
  margin: 0;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-xs);
}

.routine-inbox__text {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  white-space: pre-wrap;
}

.routine-inbox__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-xs);
}
</style>
