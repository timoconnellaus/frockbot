/// <reference path="../env.d.ts" />

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import { authSessionClientKey } from "@frockbot/plugin-auth/shared";
import {
  createSettingsFrameClient,
  settingsFrameClientKey,
} from "./settings-frames.js";
import BotPanel from "./BotPanel.vue";
import BotSettingsSurface from "./BotSettingsSurface.vue";
import BotSettingsTrigger from "./BotSettingsTrigger.vue";
import ConnectorsTrigger from "./ConnectorsTrigger.vue";
import ConnectionsSurface from "./ConnectionsSurface.vue";
import ModelsSurface from "./ModelsSurface.vue";
import PluginsSurface from "./PluginsSurface.vue";
import PackageCatalogSurface from "./PackageCatalogSurface.vue";
import UserProfileTrigger from "./UserProfileTrigger.vue";
import UserSettingsSurface from "./UserSettingsSurface.vue";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const settingsClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  const auth = ctx.inject(authSessionClientKey);
  const frames = createSettingsFrameClient(
    ctx.transport,
    () =>
      auth.projection.value.status === "authenticated"
        ? auth.projection.value.user.id
        : undefined,
    {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
  );
  return [
    ctx.provide(settingsFrameClientKey, frames),
    surfaces.register({
      id: "bot-settings",
      title: "Settings",
      component: BotSettingsSurface,
      placement: "panel",
    }),
    // Enablement and configuration are separate surfaces: Plugins turns a
    // Package on and off, Models hosts opt-in model configuration, and
    // Connectors authorizes Connections for every Bot the User owns.
    surfaces.register({
      id: "plugins",
      title: "Plugins",
      component: PluginsSurface,
    }),
    surfaces.register({
      id: "models",
      title: "Models",
      component: ModelsSurface,
    }),
    surfaces.register({
      id: "connections",
      title: "Connectors",
      component: ConnectionsSurface,
    }),
    surfaces.register({
      id: "package-catalog",
      title: "All plugins",
      component: PackageCatalogSurface,
    }),
    surfaces.register({
      id: "user-settings",
      title: "Settings",
      component: UserSettingsSurface,
    }),
    ctx.slot({
      slot: "frockbot.sidebar-actions",
      order: 10,
      component: ConnectorsTrigger,
    }),
    ctx.slot({
      slot: "frockbot.user-profile",
      order: 10,
      component: UserProfileTrigger,
    }),
    ctx.slot({
      slot: "frockbot.right-panel",
      order: 10,
      component: BotPanel,
    }),
    ctx.slot({
      slot: "frockbot.bot-actions",
      order: 10,
      component: BotSettingsTrigger,
    }),
  ];
};

export {
  decodeModelSelection,
  describeModelBinding,
  eligibleModelConnections,
  encodeModelSelection,
  isModelConnectionEligible,
  modelSelectOptions,
  type ModelSelectOption,
} from "./bot-settings.js";

export default settingsClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-settings/client",
  plugin: settingsClientPlugin,
});
