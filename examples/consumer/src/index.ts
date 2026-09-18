/**
 * Thin Worker entry. A real product points `#auth-package` at its chooser
 * (wrangler `alias` or `imports`), optionally passes a Plugin catalog, and
 * owns wrangler bindings plus a greenfield migration chain.
 */
import {
  AppletState,
  BotState,
  createWorkerApp,
  DeploymentPolicy,
  UserConfiguration,
  VoiceAssistant,
} from "@frockbot/cloudflare";

export {
  AppletState,
  BotState,
  DeploymentPolicy,
  UserConfiguration,
  VoiceAssistant,
};

export default createWorkerApp();
