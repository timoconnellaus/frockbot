<script setup lang="ts">
// The Bot's Routines: the list, the create/edit form, and one run log per
// Routine. It renders durable state and submits versioned commands; it decides
// nothing — "Next run" is the moment the scheduler has actually armed an alarm
// on, sent down with the Routine, and blank when there is none to promise.
import {
  browserTimeZoneV1,
  formatMomentV1,
  formatRelativeMomentV1,
  UiAnchor,
  UiButton,
  UiField,
  UiIcon,
} from "@frockbot/client-ui";
import {
  presentClientFailureV1,
  serverRefusalMessageV1,
} from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, reactive, ref, toRaw, watch } from "vue";
import { triggerObject } from "@frockbot/connection-core";
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
// The section is deep-linkable: an error message or a send payload may cite it.
const anchorHref = computed(() =>
  settingsLinkV1({ anchor: "bot-routines", botId: botId.value }),
);
const formOpen = ref(false);
const openLog = ref<string>();
const copied = ref(false);
const openRun = ref<string>();
// An automation Turn never appears in the transcript, so opening a run here is
// the only way to read one, and it is read-only in both directions: the view
// carries what happened and no way to act on it.
function toggleRun(routineId: string, runId: string): void {
  if (openRun.value === runId) {
    openRun.value = undefined;
    return;
  }
  openRun.value = runId;
  if (botId.value && !routines.value.runDetails[runId]) {
    void routines.value.loadRun(botId.value, routineId, runId);
  }
}
const form = reactive({
  routineId: undefined as string | undefined,
  name: "",
  prompt: "",
  timing: "schedule" as "schedule" | "webhook" | "connection",
  schedule: "",
  connectionId: "",
  triggerType: "",
  config: {} as Record<string, unknown>,
  timezone: "UTC",
});

const accounts = computed(() => [
  ...new Map(
    (routines.value.triggers ?? []).map((item) => [item.connectionId, item]),
  ).values(),
]);
const events = computed(() =>
  (routines.value.triggers ?? []).filter(
    (item) => item.connectionId === form.connectionId,
  ),
);
const selectedEvent = computed(() =>
  events.value.find((item) => item.triggerType === form.triggerType),
);
const eventFields = computed(() => {
  const schema = selectedEvent.value?.configSchema;
  if (!schema || !triggerObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, value]) =>
    triggerObject(value)
      ? [
          {
            key,
            label: (typeof value.title === "string" ? value.title : key)
              .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
              .replaceAll("_", " ")
              .replace(/^./, (letter) => letter.toUpperCase()),
            hint:
              typeof value.description === "string"
                ? value.description
                : undefined,
            type: value.type,
            options: Array.isArray(value.enum)
              ? value.enum.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
            required:
              Array.isArray(schema.required) && schema.required.includes(key),
          },
        ]
      : [],
  );
});
function selectEvent(): void {
  form.config = {};
  const properties = selectedEvent.value?.configSchema.properties;
  if (triggerObject(properties))
    for (const [key, value] of Object.entries(properties)) {
      if (triggerObject(value) && value.default !== undefined)
        form.config[key] = structuredClone(toRaw(value.default));
    }
}
function selectAccount(): void {
  form.triggerType = events.value[0]?.triggerType ?? "";
  selectEvent();
}
function eventState(routine: RoutineViewV1): string {
  return (
    {
      active: "Listening",
      starting: "Starting…",
      paused: "Paused",
      missing: "Listening stopped — edit and save to restart",
      failed: "Could not start listening — review the event settings",
      unavailable: "Connection unavailable — check Connectors",
    }[routine.eventStatus ?? "unavailable"] ??
    "Connection unavailable — check Connectors"
  );
}

/**
 * The reason the last save was refused, held beside the form rather than in
 * the section header. The header sits above every Routine card, so on a Bot
 * with a few Routines the refusal rendered hundreds of pixels off-screen and
 * the form simply appeared to do nothing.
 */
const saveError = ref<string>();
/** The Routine a delete has been asked for and not yet confirmed. */
const pendingDelete = ref<RoutineViewV1>();

/**
 * Whether a refusal is about the schedule, so it can be rendered under the
 * Schedule field. Every schedule refusal comes from one validator, and it
 * names cron, the expression, or the time zone.
 */
const scheduleError = computed(() =>
  saveError.value !== undefined &&
  form.timing === "schedule" &&
  /cron|schedule|expression|time zone|timezone|occurrence/iu.test(
    saveError.value,
  )
    ? saveError.value
    : undefined,
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

/**
 * The delivery URL, composed here because the browser is the only place that
 * knows the origin the caller will use. The key is appended as the bearer token
 * the route reads, and it is on screen once: nothing can fetch it again.
 */
function hookUrl(): string {
  const mint = routines.value.mintedHook;
  if (!mint) return "";
  return `${window.location.origin}${mint.path}`;
}

async function copyHook(): Promise<void> {
  const mint = routines.value.mintedHook;
  if (!mint) return;
  try {
    await navigator.clipboard.writeText(
      `curl -X POST ${hookUrl()} -H "Authorization: Bearer ${mint.token}" -d '{}'`,
    );
    copied.value = true;
  } catch {
    // Clipboard access can be refused; the key is on screen either way.
    copied.value = false;
  }
}

function summary(routine: RoutineViewV1): string {
  return routine.schedule
    ? `${routine.schedule} · ${routine.timezone}`
    : routine.trigger?.kind === "connection"
      ? (routine.eventName ?? "Connected account event")
      : "Webhook trigger";
}

/** A durable moment, read in the Routine's own zone — the one it fires on. */
function moment(routine: RoutineViewV1, iso: string): string {
  return formatMomentV1(iso, { timeZone: routine.timezone });
}

function startCreate(): void {
  if (botId.value) void routines.value.load(botId.value);
  form.routineId = undefined;
  form.name = "";
  form.prompt = "";
  form.timing = "schedule";
  form.connectionId = accounts.value[0]?.connectionId ?? "";
  selectAccount();
  form.schedule = "0 9 * * *";
  // The reader's own zone, not UTC: a schedule is almost always meant in the
  // day the person writing it is living in, and the Bot picks the same when it
  // writes one itself.
  form.timezone = browserTimeZoneV1();
  saveError.value = undefined;
  formOpen.value = true;
}

function startEdit(routine: RoutineViewV1): void {
  form.routineId = routine.routineId;
  form.name = routine.name;
  form.prompt = routine.prompt;
  form.timing = routine.schedule
    ? "schedule"
    : routine.trigger?.kind === "connection"
      ? "connection"
      : "webhook";
  if (routine.trigger?.kind === "connection") {
    form.connectionId = routine.trigger.connectionId;
    form.triggerType = routine.trigger.triggerType;
    form.config = structuredClone(toRaw(routine.trigger.config));
  }
  form.schedule = routine.schedule ?? "";
  form.timezone = routine.timezone;
  saveError.value = undefined;
  formOpen.value = true;
}

async function submit(): Promise<void> {
  const id = botId.value;
  if (!id) return;
  saveError.value = undefined;
  try {
    if (form.timing === "connection" && !selectedEvent.value)
      throw new Error("Choose an available account and event");
    const config = Object.fromEntries(
      Object.entries(form.config).filter(
        ([, value]) => value !== "" && value !== undefined,
      ),
    );
    for (const field of eventFields.value) {
      if (field.required && config[field.key] === undefined)
        throw new Error(`Enter ${field.label.toLowerCase()}`);
      if (
        config[field.key] !== undefined &&
        (field.type === "array" || field.type === "object") &&
        typeof config[field.key] === "string"
      ) {
        try {
          config[field.key] = JSON.parse(String(config[field.key]));
        } catch {
          throw new Error(
            `Check ${field.label.toLowerCase()}: enter valid JSON`,
          );
        }
      }
    }
    await routines.value.save(id, {
      ...(form.routineId ? { routineId: form.routineId } : {}),
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      ...(form.timing === "schedule"
        ? { schedule: form.schedule.trim() }
        : form.timing === "connection"
          ? {
              trigger: {
                kind: "connection" as const,
                connectionId: form.connectionId,
                triggerType: form.triggerType,
                config,
              },
            }
          : { trigger: { kind: "webhook" as const } }),
      timezone: form.timezone.trim(),
    });
    formOpen.value = false;
  } catch (error) {
    // The form stays open and holds the reason itself, beside the field that
    // caused it. The section header keeps its copy for the reader who scrolls
    // back up, but the form no longer refuses in silence.
    //
    // A refused save is the deployment explaining a rule it holds — which
    // field is wrong and why — so its own sentence is what belongs here. A
    // fault carries no such sentence, and the classified failure's short one
    // is what a person can act on instead of a stack's worth of plumbing.
    saveError.value =
      serverRefusalMessageV1(error) ??
      routines.value.error ??
      (error instanceof Error
        ? error.message
        : presentClientFailureV1(error, "save the Routine"));
  }
}

/**
 * Deleting takes a Routine, its schedule, its prompt and its whole run log
 * with it, and the button sits in a row of six others. It asks first.
 */
function askDelete(routine: RoutineViewV1): void {
  pendingDelete.value = routine;
}

async function confirmDelete(): Promise<void> {
  const routine = pendingDelete.value;
  const id = botId.value;
  pendingDelete.value = undefined;
  if (!routine || !id) return;
  await routines.value.remove(id, routine.routineId);
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
  <UiAnchor
    as="section"
    anchor="bot-routines"
    label="Routines"
    :href="anchorHref"
    class="routines"
  >
    <header class="routines__header">
      <span class="routines__icon" aria-hidden="true"
        ><UiIcon name="history"
      /></span>
      <span class="routines__intro">
        <strong>Routines</strong>
        <small>
          Standing instructions this Bot runs on a schedule or when something
          happens.
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
      No Routines yet. Set one up to have this Bot do something on a schedule.
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
      <div
        v-if="routines.mintedHook?.routineId === routine.routineId"
        class="routine-hook"
      >
        <strong
          >Webhook key, version {{ routines.mintedHook.keyVersion }}</strong
        >
        <small>
          This is the only time you'll see this key. Copy it now — you'll need a
          new one otherwise.
        </small>
        <code>{{ hookUrl() }}</code>
        <code class="routine-hook__token">{{ routines.mintedHook.token }}</code>
        <div class="routine-card__actions">
          <UiButton type="button" variant="primary" @click="copyHook">
            {{ copied ? "Copied" : "Copy webhook URL" }}
          </UiButton>
          <UiButton type="button" @click="routines.dismissHook()">
            Done
          </UiButton>
        </div>
      </div>
      <p
        v-if="routine.trigger?.kind === 'connection'"
        class="routines__note"
        role="status"
      >
        {{ eventState(routine) }}
      </p>
      <dl class="routine-card__facts">
        <div>
          <dt>Next run</dt>
          <dd>
            <time v-if="routine.nextRunAt" :datetime="routine.nextRunAt">{{
              moment(routine, routine.nextRunAt)
            }}</time>
            <template v-else>—</template>
          </dd>
        </div>
        <div v-if="routine.trigger?.kind === 'webhook'">
          <dt>Webhook key</dt>
          <dd>
            {{
              routine.hookKeyVersion
                ? `version ${routine.hookKeyVersion}`
                : "none"
            }}
          </dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>
            <time
              v-if="routine.lastRunAt"
              :datetime="routine.lastRunAt"
              :title="moment(routine, routine.lastRunAt)"
              >{{ formatRelativeMomentV1(routine.lastRunAt) }}</time
            >
            <template v-else>Never</template>
          </dd>
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
        <UiButton
          type="button"
          :disabled="routines.busy"
          @click="botId && routines.runNow(botId, routine.routineId)"
        >
          Run now
        </UiButton>
        <UiButton
          v-if="routine.trigger?.kind === 'webhook'"
          type="button"
          :disabled="routines.busy"
          @click="botId && routines.rotateKey(botId, routine.routineId)"
        >
          {{ routine.hookKeyVersion ? "Rotate key" : "Mint key" }}
        </UiButton>
        <UiButton
          v-if="routine.trigger?.kind === 'webhook' && routine.hookKeyVersion"
          type="button"
          :disabled="routines.busy"
          @click="botId && routines.revokeKey(botId, routine.routineId)"
        >
          Revoke key
        </UiButton>
        <UiButton type="button" @click="toggleLog(routine.routineId)">
          {{ openLog === routine.routineId ? "Hide runs" : "Run log" }}
        </UiButton>
        <UiButton
          type="button"
          variant="danger"
          :disabled="routines.busy"
          @click="askDelete(routine)"
        >
          Delete
        </UiButton>
      </div>
      <div
        v-if="pendingDelete?.routineId === routine.routineId"
        class="routine-confirm"
        role="alertdialog"
        :aria-label="`Delete ${routine.name}?`"
      >
        <strong>Delete {{ routine.name }}?</strong>
        <small>
          Its schedule, its prompt and its whole run log go with it. This can't
          be undone.
        </small>
        <div class="routine-card__actions">
          <UiButton type="button" @click="pendingDelete = undefined">
            Cancel
          </UiButton>
          <UiButton
            type="button"
            variant="danger"
            :disabled="routines.busy"
            @click="confirmDelete"
          >
            Delete Routine
          </UiButton>
        </div>
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
            <button
              type="button"
              class="routine-card__run"
              :aria-expanded="openRun === entry.runId"
              @click="toggleRun(routine.routineId, entry.runId)"
            >
              <span
                ><time
                  :datetime="entry.startedAt"
                  :title="moment(routine, entry.startedAt)"
                  >{{ formatRelativeMomentV1(entry.startedAt) }}</time
                ></span
              >
              <span>{{ entry.trigger }}</span>
              <span>{{ entry.status }}</span>
            </button>
            <ol
              v-if="openRun === entry.runId && routines.runDetails[entry.runId]"
              class="routine-card__events"
            >
              <li
                v-for="(event, index) in routines.runDetails[entry.runId]!
                  .events"
                :key="`${entry.runId}:${index}`"
              >
                {{ event.summary }}
              </li>
            </ol>
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
        <label>
          <input v-model="form.timing" type="radio" value="connection" />
          <span>An event in a connected account</span>
        </label>
      </fieldset>
      <template v-if="form.timing === 'connection'">
        <p
          v-if="routines.triggerError"
          class="routine-form__error"
          role="alert"
        >
          {{ routines.triggerError }}
        </p>
        <p v-else-if="!accounts.length" class="routines__note">
          No events are available for your connected accounts yet.
        </p>
        <template v-else>
          <UiField label="Account">
            <select v-model="form.connectionId" @change="selectAccount">
              <option disabled value="">Choose an account</option>
              <option
                v-for="account in accounts"
                :key="account.connectionId"
                :value="account.connectionId"
              >
                {{ account.connectorName }} · {{ account.accountName }}
              </option>
            </select>
          </UiField>
          <UiField label="When" :hint="selectedEvent?.description">
            <select v-model="form.triggerType" @change="selectEvent">
              <option disabled value="">Choose an event</option>
              <option
                v-for="event in events"
                :key="event.triggerType"
                :value="event.triggerType"
              >
                {{ event.name }}
              </option>
            </select>
          </UiField>
          <details
            v-if="eventFields.length"
            :key="form.triggerType"
            class="routine-form__options"
            :open="eventFields.some((field) => field.required)"
          >
            <summary>Event options</summary>
            <UiField
              v-for="field in eventFields"
              :key="field.key"
              :label="field.label"
              :hint="field.hint"
            >
              <select
                v-if="field.options.length"
                v-model="form.config[field.key]"
                :required="field.required"
              >
                <option v-if="!field.required" value="">Any</option>
                <option
                  v-for="option in field.options"
                  :key="option"
                  :value="option"
                >
                  {{ option }}
                </option>
              </select>
              <input
                v-else-if="field.type === 'boolean'"
                v-model="form.config[field.key]"
                type="checkbox"
              />
              <input
                v-else-if="field.type === 'number' || field.type === 'integer'"
                v-model.number="form.config[field.key]"
                type="number"
                :step="field.type === 'integer' ? 1 : 'any'"
                :required="field.required"
              />
              <textarea
                v-else-if="field.type === 'array' || field.type === 'object'"
                :value="
                  typeof form.config[field.key] === 'string'
                    ? String(form.config[field.key])
                    : JSON.stringify(form.config[field.key], null, 2)
                "
                @input="
                  form.config[field.key] = (
                    $event.target as HTMLTextAreaElement
                  ).value
                "
                :required="field.required"
                rows="3"
              />
              <input
                v-else
                v-model="form.config[field.key]"
                :required="field.required"
                maxlength="8000"
              />
            </UiField>
          </details>
        </template>
      </template>
      <UiField
        v-if="form.timing === 'schedule'"
        label="Schedule"
        hint="cron, or @daily / @every 15m"
      >
        <input
          v-model="form.schedule"
          maxlength="256"
          placeholder="0 9 * * *"
          :aria-invalid="scheduleError ? 'true' : undefined"
          :aria-describedby="
            scheduleError ? 'routine-schedule-error' : undefined
          "
        />
      </UiField>
      <p
        v-if="scheduleError"
        id="routine-schedule-error"
        class="routine-form__error"
        role="alert"
      >
        {{ scheduleError }}
      </p>
      <p v-if="form.timing === 'webhook'" class="routines__note">
        A delivery key is minted when the Routine is saved, and shown once.
      </p>
      <UiField label="Time zone">
        <input
          v-model="form.timezone"
          maxlength="64"
          placeholder="Australia/Sydney"
        />
      </UiField>
      <p
        v-if="saveError && !scheduleError"
        class="routine-form__error"
        role="alert"
      >
        {{ saveError }}
      </p>
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
  </UiAnchor>
</template>

<style scoped>
.routines {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/*
 * The section head wraps rather than squeezing its own description. With the
 * action fixed at its intrinsic width, the sentence was folded into a ~180px
 * ribbon while a quarter of the panel sat empty beside it; below that basis
 * the action takes its own line instead.
 */
.routines__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.routines__header > :deep(.ui-button),
.routines__header > button {
  margin-left: auto;
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
  flex: 1 1 14rem;
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

.routine-hook {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 10px;
  background: var(--frock-surface);
}

.routine-hook strong {
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  font-weight: 600;
}

.routine-hook code {
  overflow-wrap: anywhere;
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.routine-hook__token {
  color: var(--frock-text-muted);
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
  flex-direction: column;
  gap: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-card__run {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.routine-card__events {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 6px 0 6px 16px;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-xs);
}

.routine-form__error {
  margin: 0;
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.routine-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--frock-danger-text);
  border-radius: var(--frock-radius-card);
  padding: 10px;
  background: var(--frock-surface);
}

.routine-confirm strong {
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  font-weight: 600;
}

.routine-confirm small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-form__timing {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.routine-form__options {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.routine-form__options summary {
  cursor: pointer;
  font-weight: 600;
}

.routine-form__options :deep(.ui-field) {
  margin-top: 12px;
}

.routine-form__options input[type="checkbox"] {
  width: auto;
  align-self: flex-start;
}
</style>
