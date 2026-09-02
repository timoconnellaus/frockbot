<script setup lang="ts">
// Importing a Bot from a shared template.
//
// The review card is the whole point of this surface. A template is prose from
// a stranger, and it names Packages, Skills and Routines that are about to
// become durable state in this User's account — so it is shown as four honest
// sections before anything happens, and `Create the Bot` is the only control
// that writes. Planning is a read; the record stays `planned` until it is
// pressed.
//
// What the card never offers is a way to connect anything. An import creates no
// Connection, so "Needs your own Connection" is a list of things the User must
// go and do themselves, not a checkbox.
import { UiButton, UiField, UiIcon } from "@frockbot/client-ui";
import { computed, inject, ref } from "vue";
import { botTemplateStateKey } from "./state.js";

const providedState = inject(botTemplateStateKey);
if (!providedState) {
  throw new Error("Bot template client services were not provided");
}
const templates = providedState;
const shareLink = ref("");

const review = computed(() => templates.value.reviewing);

const willInstall = computed(() =>
  (review.value?.packages ?? []).filter(
    (entry) => entry.status === "will-install",
  ),
);
const alreadyInstalled = computed(() =>
  (review.value?.packages ?? []).filter(
    (entry) => entry.status === "already-installed",
  ),
);
const missing = computed(() =>
  (review.value?.packages ?? []).filter((entry) => entry.status === "missing"),
);

const failedStep = computed(() =>
  review.value?.steps.find((step) => step.status === "failed"),
);

/**
 * A pasted link carries the share id in its last path segment. Anything else is
 * handed over untouched, so a bare share id works too.
 */
function shareIdFrom(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = URL.parse(trimmed);
  if (!url) return trimmed;
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  return last ? decodeURIComponent(last) : trimmed;
}

async function plan(): Promise<void> {
  const shareId = shareIdFrom(shareLink.value);
  if (!shareId) return;
  await templates.value.planImport(shareId);
}
</script>

<template>
  <section class="import">
    <header class="import__header">
      <span class="import__icon" aria-hidden="true"
        ><UiIcon name="plus"
      /></span>
      <span class="import__intro">
        <strong>Import a Bot template</strong>
        <small>
          Paste a template link to see exactly what it would create before
          anything happens. Importing never brings across Memory, credentials,
          Connections.
        </small>
      </span>
    </header>

    <p v-if="templates.importError" class="import__error" role="alert">
      {{ templates.importError }}
    </p>

    <div v-if="!review" class="import__form">
      <UiField label="Template link">
        <input
          v-model="shareLink"
          maxlength="500"
          placeholder="https://…/templates/v1/…"
        />
      </UiField>
      <UiButton
        type="button"
        :disabled="templates.busy || !shareLink.trim()"
        @click="plan"
      >
        {{ templates.busy ? "Reading…" : "Review the template" }}
      </UiButton>
    </div>

    <article v-else class="review">
      <div class="review__head">
        <span class="review__text">
          <strong>{{ review.botName }}</strong>
          <small>
            {{
              review.status === "planned"
                ? "Nothing has been created yet."
                : `Import ${review.status}.`
            }}
          </small>
        </span>
      </div>

      <section class="review__section">
        <h4>Will create</h4>
        <ul>
          <li>The Bot “{{ review.botName }}”</li>
          <li v-if="review.skills.length > 0">
            {{ review.skills.length }} Skill(s):
            {{ review.skills.join(", ") }}
          </li>
          <li v-for="routine in review.routines" :key="routine.slug">
            Routine “{{ routine.slug }}”{{
              routine.disabled ? " — created paused, with no webhook key" : ""
            }}
          </li>
        </ul>
      </section>

      <section v-if="willInstall.length > 0" class="review__section">
        <h4>Will install</h4>
        <ul>
          <li v-for="entry in willInstall" :key="entry.catalogId">
            {{ entry.displayName }} ({{ entry.version }})
          </li>
        </ul>
      </section>

      <section v-if="alreadyInstalled.length > 0" class="review__section">
        <h4>Already installed</h4>
        <ul>
          <li v-for="entry in alreadyInstalled" :key="entry.catalogId">
            {{ entry.displayName }}
          </li>
        </ul>
      </section>

      <section v-if="missing.length > 0" class="review__section">
        <h4>Missing from your catalog</h4>
        <ul>
          <li v-for="entry in missing" :key="entry.catalogId">
            {{ entry.displayName }} — not in the Catalog generation you are
            pinned to, so it will be skipped.
          </li>
        </ul>
      </section>

      <section v-if="review.connections.length > 0" class="review__section">
        <h4>Needs your own Connection</h4>
        <ul>
          <li v-for="entry in review.connections" :key="entry.name">
            {{ entry.name
            }}<template v-if="entry.url"> — {{ entry.url }}</template>
            <small v-if="entry.hint"> {{ entry.hint }}</small>
          </li>
        </ul>
        <p class="import__note">
          None of these is created for you. Add each one yourself on your
          Connections surface; every Bot will hold it once it is ready.
        </p>
      </section>

      <p v-if="review.failure" class="import__error" role="alert">
        {{ review.failure }}
      </p>
      <p v-if="failedStep" class="import__note">
        The import stopped at “{{ failedStep.key }}”. Everything before it is
        already in place; confirming again retries from there.
      </p>

      <div class="review__actions">
        <UiButton
          v-if="review.status !== 'applied'"
          type="button"
          variant="primary"
          :disabled="templates.busy"
          @click="templates.applyImport(review.importId)"
        >
          {{
            templates.busy
              ? "Creating…"
              : review.status === "failed"
                ? "Retry the import"
                : "Create the Bot"
          }}
        </UiButton>
        <UiButton type="button" @click="templates.dismissReview()">
          {{ review.status === "applied" ? "Done" : "Cancel" }}
        </UiButton>
      </div>
    </article>
  </section>
</template>

<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.import__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.import__icon {
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

.import__intro {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.import__intro strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.import__intro small,
.import__note {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.import__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.import__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.review {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 12px;
  background: var(--frock-surface-subtle);
}

.review__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.review__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.review__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.review__text small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.review__section h4 {
  margin: 0 0 4px;
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
  font-weight: 600;
}

.review__section ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
}

.review__section li {
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
}

.review__section li small {
  color: var(--frock-text-muted);
}

.review__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
