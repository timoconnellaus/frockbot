/// <reference path="../env.d.ts" />

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import { ref } from "vue";
import {
  compositionWebDataKey,
  createCompositionWebData,
  type CompositionWebData,
} from "./composition-state.js";
import BotSettingsSurface from "./BotSettingsSurface.vue";
import BotSettingsTrigger from "./BotSettingsTrigger.vue";
import PluginsSurface from "./PluginsSurface.vue";
import PluginsTrigger from "./PluginsTrigger.vue";
import UserProfileTrigger from "./UserProfileTrigger.vue";
import UserSettingsSurface from "./UserSettingsSurface.vue";

export const settingsClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  // The Composition surface reads Bot Durable Object records over the hosted
  // protocol; a shell without it simply reports the surface unavailable.
  const composition = ref<CompositionWebData>(
    undefined as unknown as CompositionWebData,
  );
  composition.value = createCompositionWebData(composition, {
    ...(ctx.transport.hostedRequest
      ? { request: ctx.transport.hostedRequest.bind(ctx.transport) }
      : {}),
    ...(ctx.transport.readAuthenticatedUserId
      ? {
          readAuthenticatedUserId: ctx.transport.readAuthenticatedUserId.bind(
            ctx.transport,
          ),
        }
      : {}),
  });
  return [
    ctx.provide(compositionWebDataKey, composition),
    surfaces.register({
      id: "bot-settings",
      title: "Bot settings",
      component: BotSettingsSurface,
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
      order: 10,
      component: BotSettingsTrigger,
    }),
  ];
};

export default settingsClientPlugin;
