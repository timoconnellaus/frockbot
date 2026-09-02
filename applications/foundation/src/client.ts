import type { ClientPlugin } from "@frockbot/client-core";
import authClientPlugin from "@frockbot/plugin-auth/client";
import adminClientPlugin from "@frockbot/plugin-admin/client";
import botTemplateClientPlugin from "@frockbot/plugin-bot-template/client";
import uiThemeClientPlugin from "@frockbot/plugin-ui-theme/client";
import packagePublisherClientPlugin from "@frockbot/plugin-package-publisher/client";
import routinesClientPlugin from "@frockbot/plugin-routines/client";
import settingsClientPlugin from "@frockbot/plugin-settings/client";
import customModelsClientPlugin from "@frockbot/plugin-custom-models/client";

// The immutable application owns the concrete client contribution list.
import computerClientPlugin from "../../../packages/plugin-computer/src/client/application.js";
import flockClientPlugin from "@frockbot/plugin-flock/client";
import auditClientPlugin from "@frockbot/plugin-audit/client";
import searchClientPlugin from "@frockbot/plugin-search/client";
import userMachineClientPlugin from "@frockbot/plugin-user-machine/client";
import shellClientPlugin from "@frockbot/plugin-shell/client";

export const foundationClientPlugins: readonly ClientPlugin[] = [
  uiThemeClientPlugin,
  authClientPlugin,
  shellClientPlugin,
  adminClientPlugin,
  computerClientPlugin,
  flockClientPlugin,
  // After Flock: the Search surface injects the shell registry Flock also uses.
  searchClientPlugin,
  settingsClientPlugin,
  customModelsClientPlugin,
  routinesClientPlugin,
  botTemplateClientPlugin,
  // After Settings: the Audit log mounts into the Advanced Bot settings slot
  // Settings declares.
  auditClientPlugin,
  packagePublisherClientPlugin,
  // After Settings: the Computer section mounts into the User settings slot
  // Settings declares.
  userMachineClientPlugin,
];
