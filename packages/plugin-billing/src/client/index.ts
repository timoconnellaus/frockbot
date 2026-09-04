/// <reference path="../env.d.ts" />

import type { ClientPlugin } from "@frockbot/client-core";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";
import { ref } from "vue";
import { decodeUsageReportV1 } from "../shared.js";
import BotSpendLine from "./BotSpendLine.vue";
import UsageSection from "./UsageSection.vue";
import { usageStateKey, type UsageClientStateV1 } from "./state.js";

export const billingClientPlugin: ClientPlugin = (ctx) => {
  const state = ref<UsageClientStateV1>({
    loaded: false,
    busy: false,
    async load() {
      if (!ctx.transport.hostedRequest) {
        state.value.error = "Usage is unavailable on this client";
        return;
      }
      state.value.busy = true;
      try {
        state.value.report = decodeUsageReportV1(
          await ctx.transport.hostedRequest("/api/usage"),
        );
        state.value.loaded = true;
        state.value.error = undefined;
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not load usage";
      } finally {
        state.value.busy = false;
      }
    },
  });

  return [
    ctx.provide(usageStateKey, state),
    ctx.slot({
      slot: "frockbot.user-settings-primary-sections",
      order: 20,
      component: UsageSection,
    }),
    ctx.slot({
      slot: "frockbot.bot-settings-primary-sections",
      order: 30,
      component: BotSpendLine,
    }),
  ];
};

export default billingClientPlugin;

export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-billing/client",
  plugin: billingClientPlugin,
});
