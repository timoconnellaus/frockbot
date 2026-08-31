<script setup lang="ts">
// The Routines line of the per-Bot info pane.
//
// A glance, not a section: counts, the next armed firing and the last one,
// with a link into the full section in Bot settings. Every value comes from the
// same listing the section reads, so the pane never claims a firing the
// authority has not armed.
import { UiAnchor, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, watch } from "vue";
import { routinesStateKey } from "./state.js";
import { summarizeRoutinesV1 } from "./routines-summary.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(routinesStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Routines client services were not provided");
}
const web = providedWeb;
const routines = providedState;
const botId = computed(() => web.value.activeBotId);
const summary = computed(() =>
  summarizeRoutinesV1(
    routines.value.botId === botId.value ? routines.value.routines : [],
  ),
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
      <span class="routines-summary__icon" aria-hidden="true"
        ><UiIcon name="history" size="sm"
      /></span>
      <h3>Routines</h3>
      <span class="routines-summary__count"
        >{{ summary.enabled }}/{{ summary.total }} enabled</span
      >
    </header>
    <p v-if="summary.total === 0" class="routines-summary__empty">
      No Routines yet.
      <a :href="sectionLink">Add one in Bot settings.</a>
    </p>
    <dl v-else class="routines-summary__facts">
      <div>
        <dt>Next run</dt>
        <dd>
          {{
            summary.nextRunAt
              ? `${summary.nextRunAt} · ${summary.nextRunName}`
              : "None armed"
          }}
        </dd>
      </div>
      <div>
        <dt>Last run</dt>
        <dd>
          {{
            summary.lastRunAt
              ? `${summary.lastRunAt} · ${summary.lastRunName}`
              : "Never"
          }}
        </dd>
      </div>
      <div v-if="summary.webhooks > 0">
        <dt>Webhook triggers</dt>
        <dd>{{ summary.webhooks }}</dd>
      </div>
    </dl>
  </UiAnchor>
</template>

<style scoped>
.routines-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface);
}

.routines-summary__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.routines-summary__icon {
  display: grid;
  place-items: center;
  color: var(--frock-text-muted);
}

.routines-summary__head h3 {
  flex: 1 1 auto;
  margin: 0;
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.routines-summary__count {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routines-summary__empty {
  margin: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routines-summary__facts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.routines-summary__facts div {
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.routines-summary__facts dt {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routines-summary__facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  text-align: right;
  font-size: var(--frock-text-sm);
}
</style>
