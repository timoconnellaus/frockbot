<script setup lang="ts">
// The Routines glance in the default Bot panel. Every row comes from the same
// durable listing the full editor reads.
import { UiAnchor, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, watch } from "vue";
import { routinesStateKey } from "./state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(routinesStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Routines client services were not provided");
}
const web = providedWeb;
const routines = providedState;
const botId = computed(() => web.value.activeBotId);
const rows = computed(() =>
  routines.value.botId === botId.value ? routines.value.routines : [],
);
const link = computed(() =>
  settingsLinkV1({ anchor: "bot-info-routines", botId: botId.value }),
);
const sectionLink = computed(() =>
  settingsLinkV1({ anchor: "bot-routines", botId: botId.value }),
);

watch(
  botId,
  (id) => {
    if (!id) return;
    if (routines.value.botId !== id || !routines.value.loaded) {
      void routines.value.load(id);
    }
  },
  { immediate: true },
);
</script>

<template>
  <UiAnchor
    as="section"
    anchor="bot-info-routines"
    label="Routines"
    :href="link"
    class="routines-summary"
  >
    <header class="routines-summary__head">
      <h3>Routines</h3>
      <a
        class="routines-summary__add"
        :href="sectionLink"
        aria-label="Open Routines editor"
        title="Open Routines editor"
      >
        <UiIcon name="plus" size="sm" />
      </a>
    </header>
    <p v-if="rows.length === 0" class="routines-summary__empty">
      No Routines yet.
    </p>
    <ul v-else class="routines-summary__rows">
      <li v-for="routine in rows" :key="routine.routineId">
        <span>
          <strong>{{ routine.name }}</strong>
          <small>{{
            routine.schedule ?? routine.eventName ?? "Webhook"
          }}</small>
        </span>
        <small>{{ routine.enabled ? "On" : "Paused" }}</small>
      </li>
    </ul>
  </UiAnchor>
</template>

<style scoped>
.routines-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: var(--frock-control-sm);
}

.routines-summary__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.routines-summary__add {
  display: grid;
  width: var(--frock-control-sm);
  height: var(--frock-control-sm);
  place-items: center;
  border-radius: var(--frock-radius-control);
  color: var(--frock-text);
}

.routines-summary__add:hover {
  background: var(--frock-fill-hover);
}

.routines-summary__head h3 {
  flex: 1 1 auto;
  margin: 0;
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.routines-summary__empty {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routines-summary__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.routines-summary__rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--frock-border);
}

.routines-summary__rows li > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.routines-summary__rows strong {
  overflow: hidden;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.routines-summary__rows small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}
</style>
