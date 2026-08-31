<script setup lang="ts">
// The Bot's Routines: the list, the create/edit form, and one run log per
// Routine. It renders durable state and submits versioned commands; it decides
// nothing. "Next run" is deliberately blank — no scheduler exists yet, and a
// computed-looking time the backend never promised would be a lie in the UI.
import { UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, reactive, ref, watch } from "vue";
import type { RoutineViewV1 } from "../shared.js";
import { routinesStateKey } from "./state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(routinesStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Routines client services were not provided");
}
const web = providedWeb;
const routines = providedState;

const botId = computed(() => web.value.activeBotId);
const formOpen = ref(false);
const openLog = ref<string>();
const form = reactive({
  routineId: undefined as string | undefined,
  name: "",
  prompt: "",
  timing: "schedule" as "schedule" | "webhook",
  schedule: "",
  timezone: "UTC",
});

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

function summary(routine: RoutineViewV1): string {
  return routine.schedule
    ? `${routine.schedule} · ${routine.timezone}`
    : "Webhook trigger";
}

function startCreate(): void {
  form.routineId = undefined;
  form.name = "";
  form.prompt = "";
  form.timing = "schedule";
  form.schedule = "0 9 * * *";
  form.timezone = "UTC";
  formOpen.value = true;
}

function startEdit(routine: RoutineViewV1): void {
  form.routineId = routine.routineId;
  form.name = routine.name;
  form.prompt = routine.prompt;
  form.timing = routine.schedule ? "schedule" : "webhook";
  form.schedule = routine.schedule ?? "";
  form.timezone = routine.timezone;
  formOpen.value = true;
}

async function submit(): Promise<void> {
  const id = botId.value;
  if (!id) return;
  try {
    await routines.value.save(id, {
      ...(form.routineId ? { routineId: form.routineId } : {}),
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      ...(form.timing === "schedule"
        ? { schedule: form.schedule.trim() }
        : { trigger: { kind: "webhook" as const } }),
      timezone: form.timezone.trim(),
    });
    formOpen.value = false;
  } catch {
    // The state holds the reason; the form stays open so it can be corrected.
  }
}

async function toggleLog(routineId: string): Promise<void> {
  const id = botId.value;
  if (!id) return;
  if (openLog.value === routineId) {
    openLog.value = undefined;
    return;
  }
  openLog.value = routineId;
  await routines.value.loadRuns(id, routineId);
}
</script>

<template>
  <section class="routines">
    <header class="routines__header">
      <span class="routines__icon" aria-hidden="true"
        ><UiIcon name="history"
      /></span>
      <span class="routines__intro">
        <strong>Routines</strong>
        <small>
          Standing instructions this Bot runs on a schedule or on a delivered
          webhook, as their own Turns.
        </small>
      </span>
      <UiButton type="button" :disabled="!botId" @click="startCreate">
        New Routine
      </UiButton>
    </header>

    <p v-if="routines.error" class="routines__error" role="alert">
      {{ routines.error }}
    </p>

    <p
      v-if="routines.loaded && routines.routines.length === 0"
      class="routines__empty"
    >
      No Routines yet. A Routine fires on its own and reports back on this Bot's
      next conversation.
    </p>

    <article
      v-for="routine in routines.routines"
      :key="routine.routineId"
      class="routine-card"
    >
      <div class="routine-card__head">
        <span class="routine-card__text">
          <strong>{{ routine.name }}</strong>
          <small>{{ summary(routine) }}</small>
        </span>
        <span
          class="routine-card__state"
          :data-enabled="routine.enabled ? 'yes' : 'no'"
        >
          {{ routine.enabled ? "Enabled" : "Paused" }}
        </span>
      </div>
      <dl class="routine-card__facts">
        <div>
          <dt>Next run</dt>
          <dd>—</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>{{ routine.lastRunAt ?? "Never" }}</dd>
        </div>
        <div>
          <dt>Written by</dt>
          <dd>{{ routine.updatedBy.kind === "bot" ? "the Bot" : "you" }}</dd>
        </div>
      </dl>
      <div class="routine-card__actions">
        <UiButton
          type="button"
          :disabled="routines.busy"
          @click="startEdit(routine)"
        >
          Edit
        </UiButton>
        <UiButton
          type="button"
          :disabled="routines.busy"
          @click="
            botId &&
            routines.setEnabled(botId, routine.routineId, !routine.enabled)
          "
        >
          {{ routine.enabled ? "Pause" : "Resume" }}
        </UiButton>
        <UiButton type="button" @click="toggleLog(routine.routineId)">
          {{ openLog === routine.routineId ? "Hide runs" : "Run log" }}
        </UiButton>
        <UiButton
          type="button"
          variant="danger"
          :disabled="routines.busy"
          @click="botId && routines.remove(botId, routine.routineId)"
        >
          Delete
        </UiButton>
      </div>
      <div v-if="openLog === routine.routineId" class="routine-card__log">
        <p
          v-if="(routines.runs[routine.routineId] ?? []).length === 0"
          class="routines__empty"
        >
          This Routine has not fired yet.
        </p>
        <ul v-else>
          <li
            v-for="entry in routines.runs[routine.routineId]"
            :key="entry.entryId"
          >
            <span>{{ entry.startedAt }}</span>
            <span>{{ entry.trigger }}</span>
            <span>{{ entry.status }}</span>
          </li>
        </ul>
      </div>
    </article>

    <div v-if="formOpen" class="routine-form">
      <strong>{{ form.routineId ? "Edit Routine" : "New Routine" }}</strong>
      <UiField label="Name">
        <input v-model="form.name" maxlength="100" required />
      </UiField>
      <UiField label="Prompt" hint="what the Routine does when it fires">
        <textarea v-model="form.prompt" maxlength="8000" rows="5" />
      </UiField>
      <fieldset class="routine-form__timing">
        <legend>Fires on</legend>
        <label>
          <input v-model="form.timing" type="radio" value="schedule" />
          <span>A schedule</span>
        </label>
        <label>
          <input v-model="form.timing" type="radio" value="webhook" />
          <span>A webhook</span>
        </label>
      </fieldset>
      <UiField
        v-if="form.timing === 'schedule'"
        label="Schedule"
        hint="cron, or @daily / @every 15m"
      >
        <input
          v-model="form.schedule"
          maxlength="256"
          placeholder="0 9 * * *"
        />
      </UiField>
      <p v-else class="routines__note">
        The delivery URL and its key are minted when webhook delivery ships.
      </p>
      <UiField label="Time zone">
        <input
          v-model="form.timezone"
          maxlength="64"
          placeholder="Australia/Sydney"
        />
      </UiField>
      <div class="routine-card__actions">
        <UiButton
          type="button"
          variant="primary"
          :disabled="routines.busy"
          @click="submit"
        >
          {{ routines.busy ? "Saving…" : "Save Routine" }}
        </UiButton>
        <UiButton type="button" @click="formOpen = false">Cancel</UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.routines {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.routines__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.routines__icon {
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

.routines__intro {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.routines__intro strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.routines__intro small,
.routines__empty,
.routines__note {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routines__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.routine-card,
.routine-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 12px;
  background: var(--frock-surface-subtle);
}

.routine-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.routine-card__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.routine-card__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.routine-card__text small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-card__state {
  flex: 0 0 auto;
  border-radius: var(--frock-radius-control);
  padding: 2px 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  box-shadow: inset 0 0 0 1px var(--frock-border);
}

.routine-card__state[data-enabled="yes"] {
  color: var(--frock-action-primary);
}

.routine-card__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0;
}

.routine-card__facts dt {
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.routine-card__facts dd {
  margin: 0;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.routine-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.routine-card__log ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.routine-card__log li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-form__timing {
  display: flex;
  gap: 12px;
  border: 0;
  margin: 0;
  padding: 0;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-form__timing legend {
  padding: 0;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.routine-form__timing label {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
