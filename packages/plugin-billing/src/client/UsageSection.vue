<script setup lang="ts">
import { flockWebDataKey } from "@frockbot/plugin-flock/client/state";
import { computed, inject, onMounted } from "vue";
import { formatCostV1, shortModelNameV1 } from "./format.js";
import { usageStateKey } from "./state.js";

const providedUsage = inject(usageStateKey);
const providedFlock = inject(flockWebDataKey);
if (!providedUsage || !providedFlock) {
  throw new Error("usage client services were not provided");
}
const usage = providedUsage;
const flock = providedFlock;

const maximumDayCost = computed(() =>
  Math.max(1, ...(usage.value.report?.days.map((day) => day.costMicros) ?? [])),
);

function botName(botId: string): string {
  return flock.value.profiles[botId]?.name ?? botId;
}

function barWidth(costMicros: number): string {
  return `${Math.round((costMicros / maximumDayCost.value) * 100)}%`;
}

onMounted(() => void usage.value.load());
</script>

<template>
  <section class="usage-card" aria-labelledby="usage-heading">
    <header class="usage-card__header">
      <div>
        <h2 id="usage-heading">Usage</h2>
        <p>This month</p>
      </div>
      <strong class="usage-card__total">
        {{ formatCostV1(usage.report?.currentMonthCostMicros ?? 0) }}
      </strong>
    </header>

    <p v-if="usage.error" class="usage-card__error" role="alert">
      {{ usage.error }}
    </p>
    <p v-else-if="usage.busy && !usage.loaded" class="usage-card__quiet">
      Loading usage…
    </p>
    <template v-else-if="usage.report">
      <div class="usage-card__columns">
        <section>
          <h3>By Bot</h3>
          <p v-if="usage.report.bots.length === 0" class="usage-card__quiet">
            No spend yet this month.
          </p>
          <ul v-else class="usage-list">
            <li v-for="row in usage.report.bots" :key="row.id">
              <span>{{ botName(row.id) }}</span>
              <strong>{{ formatCostV1(row.costMicros) }}</strong>
            </li>
          </ul>
        </section>
        <section>
          <h3>By model</h3>
          <p v-if="usage.report.models.length === 0" class="usage-card__quiet">
            No model spend yet this month.
          </p>
          <ul v-else class="usage-list">
            <li v-for="row in usage.report.models" :key="row.id">
              <span>{{ shortModelNameV1(row.id) }}</span>
              <strong>{{ formatCostV1(row.costMicros) }}</strong>
            </li>
          </ul>
        </section>
      </div>

      <section>
        <h3>Last 30 days</h3>
        <ol class="usage-days">
          <li v-for="day in usage.report.days" :key="day.day">
            <time :datetime="day.day">{{ day.day.slice(5) }}</time>
            <span class="usage-days__track" aria-hidden="true">
              <span
                class="usage-days__bar"
                :style="{ width: barWidth(day.costMicros) }"
              />
            </span>
            <span>{{ formatCostV1(day.costMicros) }}</span>
          </li>
        </ol>
      </section>
      <p
        v-if="usage.report.estimatedCalls || usage.report.unknownPriceCalls"
        class="usage-card__quiet"
      >
        Some totals use estimates because exact usage or pricing was not
        available.
      </p>
    </template>
  </section>
</template>

<style scoped>
.usage-card {
  display: flex;
  flex-direction: column;
  gap: var(--frock-radius-card);
  padding: var(--frock-radius-card);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.usage-card__header,
.usage-list li,
.usage-days li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--frock-radius-control);
}

.usage-card h2,
.usage-card h3,
.usage-card p,
.usage-list,
.usage-days {
  margin: 0;
}

.usage-card h2 {
  font-size: var(--frock-text-xl);
}

.usage-card h3 {
  margin-bottom: var(--frock-radius-control);
  font-size: var(--frock-text-sm);
  text-transform: uppercase;
  letter-spacing: var(--frock-tracking-eyebrow);
}

.usage-card__header p,
.usage-card__quiet {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.usage-card__total {
  font-size: var(--frock-text-display);
  font-family: var(--frock-font-display);
}

.usage-card__columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--frock-radius-card);
}

.usage-list,
.usage-days {
  display: flex;
  flex-direction: column;
  gap: calc(var(--frock-radius-control) / 2);
  padding: 0;
  list-style: none;
  font-size: var(--frock-text-sm);
}

.usage-days time {
  color: var(--frock-text-muted);
  font-family: var(--frock-font-mono);
}

.usage-days__track {
  flex: 1;
  height: calc(var(--frock-icon-sm) / 2);
  overflow: hidden;
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
}

.usage-days__bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--frock-action-primary);
}

.usage-card__error {
  color: var(--frock-danger-text);
  font-size: var(--frock-text-sm);
}
</style>
