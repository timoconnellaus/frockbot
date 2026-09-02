/// <reference path="../env.d.ts" />

import type { ClientPlugin } from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import AccountModelsSection from "./AccountModelsSection.vue";
import BotModelSection from "./BotModelSection.vue";
import {
  createCustomModelsClientState,
  customModelsClientStateKey,
} from "./state.js";

export const customModelsClientPlugin: ClientPlugin = (ctx) => {
  const web = ctx.inject(frockBotWebDataKey);
  const state = createCustomModelsClientState(ctx.transport, web);
  return [
    ctx.provide(customModelsClientStateKey, state),
    ctx.slot({
      slot: "frockbot.models-sections",
      order: 0,
      component: AccountModelsSection,
    }),
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
