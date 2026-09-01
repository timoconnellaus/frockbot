import type { ClientPlugin } from "@frockbot/client-core";
import authClientPlugin from "@frockbot/plugin-auth/client";
import botTemplateClientPlugin from "@frockbot/plugin-bot-template/client";
import uiThemeClientPlugin from "@frockbot/plugin-ui-theme/client";
import packagePublisherClientPlugin from "@frockbot/plugin-package-publisher/client";
import routinesClientPlugin from "@frockbot/plugin-routines/client";
import settingsClientPlugin from "@frockbot/plugin-settings/client";

// The immutable application owns the concrete client contribution list.
// pi-lens-ignore: ts:2307
import clockClientPlugin from "@frockbot/plugin-clock/client";
import computerClientPlugin from "../../../packages/plugin-computer/src/client/application.js";
import flockClientPlugin from "@frockbot/plugin-flock/client";
import channelsClientPlugin from "@frockbot/plugin-channels/client";
import auditClientPlugin from "@frockbot/plugin-audit/client";
import searchClientPlugin from "@frockbot/plugin-search/client";
import shellClientPlugin from "@frockbot/plugin-shell/client";

export const foundationClientPlugins: readonly ClientPlugin[] = [
  uiThemeClientPlugin,
  authClientPlugin,
  shellClientPlugin,
  clockClientPlugin,
  computerClientPlugin,
  flockClientPlugin,
  // After Flock: a Channel thread draws each sender with the Flock Package's
  // own avatar, and the Channels list follows the Bot the Shell has selected.
  channelsClientPlugin,
  // After Flock: the Search surface injects the shell registry Flock also uses.
  searchClientPlugin,
  settingsClientPlugin,
  routinesClientPlugin,
  botTemplateClientPlugin,
  // After Settings: the Activity section mounts into the Bot settings slot
  // Settings declares.
  auditClientPlugin,
  packagePublisherClientPlugin,
];
