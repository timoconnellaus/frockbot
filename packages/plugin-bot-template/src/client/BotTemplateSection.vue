<script setup lang="ts">
// Bot templates, in Bot settings.
//
// The User half of the export: staging packs a recipe privately, and choosing
// a visibility is a separate, deliberate click here — "Publication beyond the
// authoring User is a User action." The link is only shown once a share is
// actually `link` or `public`, so a copied URL always resolves.
import { UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import type {
  TemplateShareRecordV1,
  TemplateVisibilityV1,
} from "@frockbot/template-core";
import { computed, inject, ref, watch } from "vue";
import { templateSharePathV1 } from "../shared.js";
import { botTemplateStateKey } from "./state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedState = inject(botTemplateStateKey);
if (!providedWeb || !providedState) {
  throw new Error("Bot template client services were not provided");
}
const web = providedWeb;
const templates = providedState;
const copied = ref<string>();
const flowOpen = ref(false);

const botId = computed(() => web.value.activeBotId);

const shares = computed(() =>
  templates.value.shares.filter((share) => share.botId === botId.value),
);

const visibilities: {
  value: TemplateVisibilityV1;
  label: string;
  hint: string;
}[] = [
  {
    value: "private",
    label: "Private",
    hint: "Only you. The recipe is staged and shared with nobody.",
  },
  {
    value: "link",
    label: "Anyone with the link",
    hint: "Unlisted. Anyone holding the link can read the recipe.",
  },
  {
    value: "public",
    label: "Public",
    hint: "Readable by anyone, and listable.",
  },
];

watch(
  botId,
  (id) => {
    if (id && !templates.value.loaded) void templates.value.load();
  },
  { immediate: true },
);

function shareUrl(share: TemplateShareRecordV1): string {
  return `${globalThis.location?.origin ?? ""}${templateSharePathV1(share.shareId)}`;
}

function describe(share: TemplateShareRecordV1): string {
  if (share.revokedAt) return `Revoked ${share.revokedAt}`;
  return (
    visibilities.find((option) => option.value === share.visibility)?.label ??
    share.visibility
  );
}

async function copyLink(share: TemplateShareRecordV1): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareUrl(share));
    copied.value = share.shareId;
  } catch {
    // Clipboard access is a progressive enhancement; the link is on screen
    // either way, so a refusal costs the convenience and nothing else.
    copied.value = undefined;
  }
}
</script>

<template>
  <section class="templates">
    <UiButton
      class="templates__open"
      type="button"
      :aria-expanded="flowOpen"
      @click="flowOpen = !flowOpen"
    >
      Share as template
    </UiButton>

    <div v-if="flowOpen" class="templates__flow">
      <header class="templates__header">
        <span class="templates__intro">
          <strong>Share this Bot</strong>
          <small>
            Packs the profile, Bot-authored Skills, Routines, and required
            Packages. Memory, credentials, Connections, and Computer files stay
            private.
          </small>
        </span>
        <UiButton
          type="button"
          :disabled="!botId || templates.busy"
          @click="botId && templates.stage(botId)"
        >
          {{ templates.busy ? "Packing…" : "Pack template" }}
        </UiButton>
      </header>

      <p v-if="templates.error" class="templates__error" role="alert">
        {{ templates.error }}
      </p>

      <p
        v-if="templates.summary && templates.openShareId"
        class="templates__summary"
      >
        Packed {{ templates.summary.skills }} Skill(s),
        {{ templates.summary.routines }} Routine(s),
        {{ templates.summary.packages }} Package(s) and
        {{ templates.summary.publicServers }} public MCP server(s).
        <template v-if="templates.summary.needsConnection > 0">
          {{ templates.summary.needsConnection }} server(s) are left as a
          placeholder the importer fills with their own Connection.
        </template>
        Memory, credentials, and Connections were not included.
      </p>

      <p
        v-if="templates.loaded && shares.length === 0"
        class="templates__empty"
      >
        No template has been shared from this Bot yet.
      </p>

      <article
        v-for="share in shares"
        :key="share.shareId"
        class="template-card"
      >
        <div class="template-card__head">
          <span class="template-card__text">
            <strong>{{ describe(share) }}</strong>
            <small>Packed {{ share.createdAt }}</small>
          </span>
        </div>

        <fieldset v-if="!share.revokedAt" class="template-card__visibility">
          <legend>Who can read it</legend>
          <label v-for="option in visibilities" :key="option.value">
            <input
              type="radio"
              :name="`visibility-${share.shareId}`"
              :value="option.value"
              :checked="share.visibility === option.value"
              :disabled="templates.busy"
              @change="templates.setVisibility(share.shareId, option.value)"
            />
            <span>
              <strong>{{ option.label }}</strong>
              <small>{{ option.hint }}</small>
            </span>
          </label>
        </fieldset>

        <p
          v-if="!share.revokedAt && share.visibility !== 'private'"
          class="template-card__link"
        >
          <code>{{ shareUrl(share) }}</code>
        </p>

        <div class="template-card__actions">
          <UiButton
            v-if="!share.revokedAt && share.visibility !== 'private'"
            type="button"
            @click="copyLink(share)"
          >
            {{ copied === share.shareId ? "Copied" : "Copy link" }}
          </UiButton>
          <UiButton
            v-if="!share.revokedAt"
            type="button"
            variant="danger"
            :disabled="templates.busy"
            @click="templates.revoke(share.shareId)"
          >
            Revoke
          </UiButton>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.templates {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.templates__open {
  width: 100%;
}

.templates__flow {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}

.templates__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.templates__intro {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.templates__intro strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.templates__intro small,
.templates__empty,
.templates__summary {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.templates__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}

.template-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  padding: 12px;
  background: var(--frock-surface-subtle);
}

.template-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.template-card__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.template-card__text strong {
  color: var(--frock-text);
  font-size: var(--frock-text-md);
  font-weight: 600;
}

.template-card__text small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.template-card__visibility {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 0;
  margin: 0;
  padding: 0;
}

.template-card__visibility legend {
  color: var(--frock-text-subtle);
  font-size: var(--frock-text-sm);
}

.template-card__visibility label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.template-card__visibility label span {
  display: flex;
  flex-direction: column;
}

.template-card__visibility label strong {
  color: var(--frock-text);
  font-size: var(--frock-text-sm);
  font-weight: 600;
}

.template-card__visibility label small {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.template-card__link {
  overflow-x: auto;
  margin: 0;
}

.template-card__link code {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.template-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
