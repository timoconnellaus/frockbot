/// <reference path="../env.d.ts" />

import type { ClientPlugin } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import BotModelSection from "./BotModelSection.vue";
import {
  createCustomModelsClientState,
  customModelsClientStateKey,
} from "./state.js";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const customModelsClientPlugin: ClientPlugin = (ctx) => {
  const web = ctx.inject(frockBotWebDataKey);
  const state = createCustomModelsClientState(ctx.transport, web);
  return [
    ctx.provide(customModelsClientStateKey, state),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 0,
      component: BotModelSection,
    }),
  ];
};

export {
  createCustomModelsClientState,
  customModelsClientStateKey,
  type CustomModelsClientState,
} from "./state.js";

export default customModelsClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-custom-models/client",
  plugin: customModelsClientPlugin,
});
