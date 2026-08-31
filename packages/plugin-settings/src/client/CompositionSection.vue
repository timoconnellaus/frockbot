<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { computed, inject, onMounted, ref, watch } from "vue";
import {
  compositionGenerationDiffV1,
  describeCompositionOriginV1,
  describeCompositionProvenanceV1,
  isOptimisticGenerationV1,
} from "./composition.js";
import { compositionWebDataKey } from "./composition-state.js";

const providedWeb = inject(frockBotWebDataKey);
const providedComposition = inject(compositionWebDataKey, undefined);
if (!providedWeb) throw new Error("shell client data was not provided");
const web = providedWeb;
const composition = providedComposition;
const confirmingGenerationId = ref<string>();

const current = computed(() =>
  composition?.value.generations.find((generation) => generation.isCurrent),
);
const diff = computed(() => {
  const selected = composition?.value.selected;
  const currentGeneration = current.value;
  if (!selected || !currentGeneration) return undefined;
  return compositionGenerationDiffV1(selected, currentGeneration);
});

async function load(): Promise<void> {
  const botId = web.value.activeBotId;
  if (!botId || !composition) return;
  await composition.value.load(botId);
}

onMounted(load);
watch(() => web.value.activeBotId, load);

async function select(generationId: string): Promise<void> {
  if (!composition) return;
  await composition.value.select(
    composition.value.selectedGenerationId === generationId
      ? undefined
      : generationId,
  );
}

async function revert(generationId: string): Promise<void> {
  confirmingGenerationId.value = undefined;
  await composition?.value.revert(generationId);
}
</script>

<template>
  <section class="composition-section">
    <header class="composition-header">
      <h3>Composition</h3>
      <small>
        Every admitted Turn runs on one recorded generation. Reverting records a
        new generation; it takes effect at the next Turn. A generation that
        fails to activate leaves the last known-good one running, and three
        consecutive failures quarantine it until you act.
      </small>
    </header>
    <p v-if="!composition?.available" class="composition-empty">
      Composition history is unavailable on this client.
    </p>
    <p v-else-if="composition.loading" class="composition-empty">
      Loading generations…
    </p>
    <p
      v-else-if="composition.generations.length === 0"
      class="composition-empty"
    >
      This Bot has no recorded Composition generations.
    </p>
    <ol v-else class="composition-list">
      <li
        v-for="generation in composition.generations"
        :key="generation.generationId"
        class="composition-generation"
        :class="{ 'is-current': generation.isCurrent }"
      >
        <div class="composition-copy">
          <strong>{{ generation.generationId }}</strong>
          <small>{{ describeCompositionOriginV1(generation.origin) }}</small>
          <small>
            {{ generation.status }} · {{ generation.createdAt }} ·
            {{ generation.members.length }} Packages
          </small>
          <small
            v-for="member in generation.members"
            :key="member.packageId"
            class="composition-member"
          >
            {{ member.packageId }}@{{ member.version }} —
            {{ describeCompositionProvenanceV1(member.provenance) }}
          </small>
          <small v-if="generation.quarantine" class="composition-quarantine">
            Quarantined {{ generation.quarantine.quarantinedAt }} after
            {{ generation.quarantine.failures }} failed activations. It is not
            retried until you revert or the Bot authors a new generation.
          </small>
          <small
            v-for="failure in generation.failures"
            :key="failure.attempt"
            class="composition-failure"
          >
            Attempt {{ failure.attempt }} failed at {{ failure.phase }} —
            {{ failure.message }}
          </small>
        </div>
        <div class="composition-actions">
          <span v-if="generation.isCurrent" class="composition-current">
            ✓ Current
          </span>
          <span
            v-else-if="isOptimisticGenerationV1(generation)"
            class="composition-pending"
          >
            Reverting…
          </span>
          <UiButton @click="select(generation.generationId)">
            {{
              composition.selectedGenerationId === generation.generationId
                ? "Hide diff"
                : "Diff"
            }}
          </UiButton>
          <UiButton
            v-if="
              !generation.isCurrent && !isOptimisticGenerationV1(generation)
            "
            variant="danger"
            @click="confirmingGenerationId = generation.generationId"
          >
            Revert
          </UiButton>
        </div>
        <div
          v-if="confirmingGenerationId === generation.generationId"
          class="composition-confirm"
        >
          <span>
            Revert to this generation? A new generation is recorded and the next
            Turn runs on it.
          </span>
          <UiButton variant="primary" @click="revert(generation.generationId)">
            Confirm revert
          </UiButton>
          <UiButton @click="confirmingGenerationId = undefined">
            Cancel
          </UiButton>
        </div>
        <table
          v-if="
            diff && composition.selectedGenerationId === generation.generationId
          "
          class="composition-diff"
        >
          <caption>
            Selected generation compared with the current one
          </caption>
          <tbody>
            <tr v-for="member in diff.members" :key="member.packageId">
              <td>{{ member.packageId }}</td>
              <td>{{ member.change }}</td>
              <td>{{ member.from?.version ?? "—" }}</td>
              <td>{{ member.to?.version ?? "—" }}</td>
              <td class="composition-hash">
                {{
                  (
                    member.to?.contentHash ??
                    member.from?.contentHash ??
                    ""
                  ).slice(0, 12)
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </li>
    </ol>
    <p v-if="composition?.error" class="settings-error" role="alert">
      {{ composition.error }}
    </p>
  </section>
</template>

<style scoped>
.composition-section {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--frock-border);
}

.composition-header h3 {
  margin: 0;
  font-family: var(--frock-font-display);
  font-size: var(--frock-text-lg);
}

.composition-header small,
.composition-empty {
  display: block;
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.composition-list {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.composition-generation {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 11px 0;
  border-top: 1px solid var(--frock-border);
}

.composition-generation.is-current {
  background: var(--frock-surface-raised);
}

.composition-copy {
  min-width: 0;
}

.composition-copy strong,
.composition-copy small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.composition-copy small {
  margin-top: 3px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.composition-member {
  font-family: var(--frock-font-mono, monospace);
}

.composition-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.composition-current {
  color: var(--frock-success);
  font-size: var(--frock-text-sm);
  font-weight: 700;
}

.composition-pending {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.composition-confirm,
.composition-diff {
  grid-column: 1 / -1;
}

.composition-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.composition-diff {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: var(--frock-text-sm);
}

.composition-diff caption {
  padding-bottom: 6px;
  color: var(--frock-text-muted);
  text-align: left;
}

.composition-diff td {
  padding: 4px 6px 4px 0;
  border-top: 1px solid var(--frock-border);
  color: var(--frock-text-muted);
}

.composition-hash {
  font-family: var(--frock-font-mono, monospace);
}

.composition-failure,
.composition-quarantine {
  white-space: normal;
  color: var(--frock-danger-text);
}

.settings-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
