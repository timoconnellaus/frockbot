<script setup lang="ts">
import { UiButton } from "@frockbot/client-ui";
import { computed, inject, onMounted } from "vue";
import { packagePublisherStateKey } from "./state.js";

const providedState = inject(packagePublisherStateKey);
if (!providedState) throw new Error("package publisher state was not provided");
const state = providedState;
const revisions = computed(() =>
  [...(state.value.history?.revisions ?? [])].toReversed(),
);

onMounted(() => state.value.load());
</script>

<template>
  <div class="publisher-surface">
    <header>
      <h2>Published setup</h2>
      <p>
        Publishing applies this setup to all of your Bots. You can go back to an
        earlier one at any time.
      </p>
    </header>

    <div v-if="revisions.length" class="revision-list">
      <article
        v-for="revision in revisions"
        :key="revision.packageRevision"
        class="revision-card"
      >
        <div>
          <strong>Version {{ revision.packageRevision }}</strong>
          <small>{{ new Date(revision.publishedAt).toLocaleString() }}</small>
        </div>
        <span
          v-if="
            state.history?.activePackageRevision === revision.packageRevision
          "
          class="active-revision"
        >
          Active
        </span>
        <UiButton
          v-else
          :disabled="state.busy"
          @click="state.rollback(revision.packageRevision)"
        >
          Roll back
        </UiButton>
      </article>
    </div>
    <p v-else-if="!state.error" class="empty-revisions">
      Nothing published yet.
    </p>
    <p v-if="state.error" class="publisher-error" role="alert">
      {{ state.error }}
    </p>
  </div>
</template>

<style scoped>
.publisher-surface {
  padding: 24px;
}

.publisher-surface h2 {
  margin: 0;
  font-family: var(--frock-font-display);
}

.publisher-surface header p,
.empty-revisions {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-base);
  line-height: 1.5;
}

.revision-list {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}

.revision-card {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--frock-border);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-raised);
  box-shadow: var(--frock-shadow-card);
}

.revision-card strong,
.revision-card small,
.revision-card code {
  display: block;
}

.revision-card small,
.revision-card code {
  margin-top: 4px;
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.active-revision {
  color: var(--frock-success);
  font-size: var(--frock-text-sm);
  font-weight: 700;
}

.publisher-error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
