/// <reference path="../env.d.ts" />

import type { ClientPlugin } from "@frockbot/client-core";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";
import { ref } from "vue";
import { decodeBillingViewV1 } from "../billing.js";
import { decodeUsageReportV1 } from "../shared.js";
import BalanceNotice from "./BalanceNotice.vue";
import BillingSection from "./BillingSection.vue";
import BotSpendLine from "./BotSpendLine.vue";
import UsageSection from "./UsageSection.vue";
import { usageStateKey, type UsageClientStateV1 } from "./state.js";

export const billingClientPlugin: ClientPlugin = (ctx) => {
  const request = (
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown> => {
    if (!ctx.transport.hostedRequest) {
      throw new Error("Billing is unavailable on this client");
    }
    return ctx.transport.hostedRequest(path, method, body);
  };
  const open = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Billing returned an invalid destination");
    }
    const result = value as Record<string, unknown>;
    if (
      result.schemaVersion !== 1 ||
      typeof result.url !== "string" ||
      !result.url.startsWith("https://")
    ) {
      throw new Error("Billing returned an invalid destination");
    }
    if (ctx.transport.openExternalAuthorization) {
      await ctx.transport.openExternalAuthorization(result.url);
    } else {
      window.location.assign(result.url);
    }
  };
  const command = async (
    path: "/api/billing/checkout" | "/api/billing/portal",
    body: Record<string, unknown>,
  ): Promise<void> => {
    state.value.busy = true;
    try {
      await open(
        await request(
          path,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            commandId: crypto.randomUUID(),
            ...body,
          }),
        ),
      );
      state.value.error = undefined;
    } catch (error) {
      state.value.error =
        error instanceof Error ? error.message : "Billing could not be opened";
    } finally {
      state.value.busy = false;
    }
  };
  const state = ref<UsageClientStateV1>({
    loaded: false,
    busy: false,
    async load() {
      if (state.value.busy) return;
      state.value.busy = true;
      try {
        const [usage, billing] = await Promise.all([
          request("/api/usage"),
          request("/api/billing"),
        ]);
        state.value.report = decodeUsageReportV1(usage);
        state.value.billing = decodeBillingViewV1(billing);
        state.value.loaded = true;
        state.value.error = undefined;
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not load usage";
      } finally {
        state.value.busy = false;
      }
    },
    subscribe: () => command("/api/billing/checkout", { kind: "subscription" }),
    buyCredits: (amountCents) =>
      command("/api/billing/checkout", { kind: "credit", amountCents }),
    manageSubscription: () => command("/api/billing/portal", {}),
  });

  return [
    ctx.provide(usageStateKey, state),
    ctx.slot({
      slot: "frockbot.user-settings-primary-sections",
      order: 20,
      component: BillingSection,
    }),
    ctx.slot({
      slot: "frockbot.user-settings-primary-sections",
      order: 30,
      component: UsageSection,
    }),
    ctx.slot({
      slot: "frockbot.bot-settings-primary-sections",
      order: 30,
      component: BotSpendLine,
    }),
    ctx.slot({
      slot: "frockbot.composer-notices",
      order: 20,
      component: BalanceNotice,
    }),
  ];
};

export default billingClientPlugin;

export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-billing/client",
  plugin: billingClientPlugin,
});
