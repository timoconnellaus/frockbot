/// <reference path="../env.d.ts" />

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import BotInfoSurface from "./BotInfoSurface.vue";
import BotInfoTrigger from "./BotInfoTrigger.vue";
import BotSettingsSurface from "./BotSettingsSurface.vue";
import BotSettingsTrigger from "./BotSettingsTrigger.vue";
import PluginsSurface from "./PluginsSurface.vue";
import PluginsTrigger from "./PluginsTrigger.vue";
import UserProfileTrigger from "./UserProfileTrigger.vue";
import UserSettingsSurface from "./UserSettingsSurface.vue";

export const settingsClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  return [
    surfaces.register({
      id: "bot-settings",
      title: "Bot settings",
      component: BotSettingsSurface,
      placement: "panel",
    }),
    // The per-Bot info pane takes the right panel the same way Bot settings
    // does, so the conversation stays beside it.
    surfaces.register({
      id: "bot-info",
      title: "Bot info",
      component: BotInfoSurface,
      placement: "panel",
    }),
    surfaces.register({
      id: "plugins",
      title: "Plugins",
      component: PluginsSurface,
    }),
    surfaces.register({
      id: "user-settings",
      title: "Application settings",
      component: UserSettingsSurface,
    }),
    ctx.slot({
      slot: "frockbot.sidebar-actions",
      order: 10,
      component: PluginsTrigger,
    }),
    ctx.slot({
      slot: "frockbot.user-profile",
      order: 10,
      component: UserProfileTrigger,
    }),
    ctx.slot({
      slot: "frockbot.bot-actions",
      order: 5,
      component: BotInfoTrigger,
    }),
    ctx.slot({
      slot: "frockbot.bot-actions",
      order: 10,
      component: BotSettingsTrigger,
    }),
  ];
};

export default settingsClientPlugin;
