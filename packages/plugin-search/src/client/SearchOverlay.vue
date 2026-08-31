<script setup lang="ts">
/**
 * Search across every Bot this User has.
 *
 * Every state is explicit and named: nothing typed yet, nothing found,
 * rebuilding, and a truncated index. A blank panel that could mean any of the
 * four is the one outcome this surface must never produce.
 */
import { UiIcon, UiIconButton } from "@frockbot/client-ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { inject } from "vue";
import { searchWebDataKey } from "./state.js";

const provided = inject(searchWebDataKey);
if (!provided) throw new Error("Search client data was not provided");
const search = provided;

const input = ref<HTMLInputElement>();
const DEBOUNCE_MS = 200;
let debounce: ReturnType<typeof setTimeout> | undefined;

void nextTick(() => input.value?.focus());
watch(
  () => search.value.query,
  () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void search.value.run(), DEBOUNCE_MS);
  },
);
onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce);
});

const results = computed(() => search.value.results);
const hasQuery = computed(() => search.value.query.trim().length > 0);
const groups = computed(() => results.value?.groups ?? []);
const totalHits = computed(() =>
  groups.value.reduce((sum, group) => sum + group.totalHits, 0),
);

function monogram(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function kindLabel(kind: string): string {
  if (kind === "user") return "You";
  if (kind === "assistant") return "Reply";
  if (kind === "tool") return "Tool";
  return "Media";
}

function whenLabel(at: string): string {
  const value = new Date(at);
  return Number.isFinite(value.getTime()) ? value.toLocaleDateString() : "";
}
</script>

<template>
  <div class="search-surface">
    <div class="search-input-row">
      <UiIcon name="search" size="sm" />
      <input
        ref="input"
        class="search-input"
        type="search"
        placeholder="Search every Bot's conversations"
        aria-label="Search query"
        :value="search.query"
        @input="search.setQuery(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="search-filters">
      <label class="search-filter">
        <input
          type="checkbox"
          :checked="search.includeArchived"
          @change="
            search.setIncludeArchived(
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        Archived Bots
      </label>
      <label class="search-filter">
        <input
          type="checkbox"
          :checked="search.includeTools"
          @change="
            search.setIncludeTools(($event.target as HTMLInputElement).checked)
          "
        />
        Tool output
      </label>
      <UiIconButton
        class="search-rebuild"
        icon="refresh"
        label="Rebuild the search index"
        size="sm"
        :disabled="search.rebuilding"
        @click="search.rebuild()"
      />
    </div>

    <!--
      The index is a projection, so a truncated or rebuilding one is reported
      rather than quietly answering with less than it holds.
    -->
    <p v-if="search.indexState === 'rebuilding'" class="search-note">
      Rebuilding the index from every Bot's stored turns. Results are incomplete
      until it finishes.
    </p>
    <p v-else-if="search.indexState === 'truncated'" class="search-note">
      This index reached its size limit, so the oldest turns were dropped.
      Rebuilding will not bring them back.
    </p>
    <p v-if="search.error" class="search-error" role="alert">
      {{ search.error }}
    </p>

    <p v-if="!hasQuery" class="search-empty">
      Type to search every conversation this account has.
    </p>
    <p v-else-if="search.loading && !results" class="search-empty">
      Searching…
    </p>
    <p v-else-if="results && totalHits === 0" class="search-empty">
      No turns match “{{ results.query }}”.
    </p>

    <ol v-else-if="results" class="search-groups">
      <li v-for="group in groups" :key="group.botId" class="search-group">
        <div class="search-group-head">
          <img
            v-if="group.avatarUrl"
            class="search-group-avatar"
            :src="group.avatarUrl"
            :alt="`${group.botName} avatar`"
          />
          <span v-else class="search-group-avatar search-group-monogram">{{
            monogram(group.botName)
          }}</span>
          <span class="search-group-name">{{ group.botName }}</span>
          <span v-if="group.archived" class="search-tag">Archived</span>
          <span v-else-if="group.hidden" class="search-tag">Hidden</span>
          <span class="search-group-count">{{ group.totalHits }}</span>
        </div>
        <ol class="search-hits">
          <li v-for="hit in group.hits" :key="`${hit.runId}-${hit.snippet}`">
            <button
              type="button"
              class="search-hit"
              @click="search.openHit(group.botId, hit.runId, hit.deepLink)"
            >
              <span class="search-hit-meta">
                <span class="search-hit-kind">{{ kindLabel(hit.kind) }}</span>
                <span class="search-hit-when">{{ whenLabel(hit.at) }}</span>
              </span>
              <span class="search-hit-snippet">{{ hit.snippet }}</span>
            </button>
          </li>
        </ol>
      </li>
    </ol>

    <p v-if="results?.page.truncated" class="search-note">
      More matches than this page holds. Narrow the query to see them.
    </p>
  </div>
</template>
