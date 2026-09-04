<script setup lang="ts">
import { UiAnchor, UiButton, UiField } from "@frockbot/client-ui";
import { settingsLinkV1 } from "@frockbot/plugin-shell/settings-links";
import { computed, inject, onMounted, ref } from "vue";
import { formatCostV1 } from "./format.js";
import { usageStateKey } from "./state.js";

const provided = inject(usageStateKey);
if (!provided) throw new Error("billing client service was not provided");
const billing = provided;
const customDollars = ref("50");
const anchorHref = settingsLinkV1({ anchor: "billing" });
const hasSubscription = computed(() =>
  ["active", "trialing", "past_due", "unpaid"].includes(
    billing.value.billing?.subscriptionStatus ?? "none",
  ),
);

onMounted(() => {
  if (!billing.value.loaded) void billing.value.load();
});

function buyCustom(): void {
  const dollars = Number(customDollars.value);
  if (!Number.isFinite(dollars)) {
    billing.value.error = "Enter an amount from $5 to $1,000.";
    return;
  }
  void billing.value.buyCredits(Math.round(dollars * 100));
}

function date(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
  }).format(new Date(value));
}
</script>

<template>
  <UiAnchor
    as="section"
    anchor="billing"
    label="Billing"
    :href="anchorHref"
    class="billing-card"
  >
    <header class="billing-card__header">
      <div>
        <h2>Billing</h2>
        <p>
          {{
            billing.billing?.plan === "basic" ? "Basic · $20/month" : "No plan"
          }}
        </p>
      </div>
      <UiButton
        v-if="hasSubscription"
        :disabled="billing.busy"
        @click="billing.manageSubscription()"
      >
        Manage subscription
      </UiButton>
      <UiButton
        v-else
        variant="primary"
        :disabled="billing.busy"
        @click="billing.subscribe()"
      >
        Subscribe to Basic
      </UiButton>
    </header>

    <p v-if="billing.error" class="billing-card__error" role="alert">
      {{ billing.error }}
    </p>
    <p v-else-if="billing.busy && !billing.loaded" class="billing-card__quiet">
      Loading billing…
    </p>

    <template v-if="billing.billing">
      <dl class="billing-totals">
        <div>
          <dt>This month's allowance used</dt>
          <dd>
            {{ formatCostV1(billing.billing.allowanceUsedMicros) }} of
            {{ formatCostV1(billing.billing.allowanceMicros) }}
          </dd>
        </div>
        <div>
          <dt>Credit balance</dt>
          <dd>{{ formatCostV1(billing.billing.creditBalanceMicros) }}</dd>
        </div>
      </dl>

      <section class="credit-purchase" aria-labelledby="buy-credit-heading">
        <h3 id="buy-credit-heading">Buy credits</h3>
        <div class="credit-purchase__packs">
          <UiButton
            v-for="amount in [25, 50, 100, 500]"
            :key="amount"
            :disabled="billing.busy"
            @click="billing.buyCredits(amount * 100)"
          >
            ${{ amount }}
          </UiButton>
        </div>
        <div class="credit-purchase__custom">
          <UiField label="Custom amount" hint="$5–$1,000 USD">
            <input
              v-model="customDollars"
              type="number"
              min="5"
              max="1000"
              step="0.01"
              inputmode="decimal"
            />
          </UiField>
          <UiButton :disabled="billing.busy" @click="buyCustom">
            Buy custom amount
          </UiButton>
        </div>
      </section>

      <section
        class="billing-history"
        aria-labelledby="billing-history-heading"
      >
        <h3 id="billing-history-heading">Billing history</h3>
        <p
          v-if="billing.billing.history.length === 0"
          class="billing-card__quiet"
        >
          No billing activity yet.
        </p>
        <ol v-else>
          <li v-for="entry in billing.billing.history" :key="entry.eventId">
            <span>
              <strong>{{ entry.description }}</strong>
              <time :datetime="entry.occurredAt">{{
                date(entry.occurredAt)
              }}</time>
            </span>
            <strong v-if="entry.amountMicros !== 0">
              {{ formatCostV1(entry.amountMicros) }}
            </strong>
          </li>
        </ol>
      </section>
    </template>
  </UiAnchor>
</template>

<style scoped>
.billing-card,
.credit-purchase,
.billing-history {
  display: flex;
  flex-direction: column;
  gap: var(--frock-radius-card);
}

.billing-card {
  padding: var(--frock-radius-card);
  border-radius: var(--frock-radius-card);
  background: var(--frock-surface-subtle);
}

.billing-card__header,
.credit-purchase__custom,
.billing-history li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--frock-radius-control);
}

.billing-card h2,
.billing-card h3,
.billing-card p,
.billing-card dl,
.billing-card ol {
  margin: 0;
}

.billing-card h2 {
  font-size: var(--frock-text-xl);
}

.billing-card h3,
.billing-totals dt {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
  text-transform: uppercase;
  letter-spacing: var(--frock-tracking-eyebrow);
}

.billing-card__header p,
.billing-card__quiet,
.billing-history time {
  color: var(--frock-text-muted);
  font-size: var(--frock-text-sm);
}

.billing-card__error {
  color: var(--frock-danger-text);
}

.billing-totals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--frock-radius-card);
}

.billing-totals div {
  padding: var(--frock-radius-control);
  border-radius: var(--frock-radius-control);
  background: var(--frock-surface-raised);
}

.billing-totals dd {
  margin: calc(var(--frock-radius-control) / 2) 0 0;
  color: var(--frock-text);
  font-family: var(--frock-font-display);
  font-size: var(--frock-text-lg);
}

.credit-purchase__packs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--frock-radius-control);
}

.credit-purchase__custom > :first-child {
  flex: 1;
}

.billing-history ol {
  display: flex;
  flex-direction: column;
  gap: var(--frock-radius-control);
  padding: 0;
  list-style: none;
}

.billing-history li + li {
  padding-top: var(--frock-radius-control);
  border-top: 1px solid var(--frock-border);
}

.billing-history li span {
  display: flex;
  flex-direction: column;
  gap: calc(var(--frock-radius-control) / 2);
}

@media (max-width: 640px) {
  .billing-card__header,
  .credit-purchase__custom {
    align-items: stretch;
    flex-direction: column;
  }

  .billing-totals {
    grid-template-columns: 1fr;
  }
}
</style>
