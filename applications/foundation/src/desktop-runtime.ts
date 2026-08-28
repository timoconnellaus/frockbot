import { createComputerAgentPlugin } from "@frockbot/plugin-computer/agent";
import computerManifest from "@frockbot/plugin-computer/manifest";
// The provider contribution owns Fly credentials and lifecycle authority.
import flySpriteProviderPlugin from "../../../packages/plugin-fly-sprite/src/provider.js";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";

export const computerRuntimePackage = {
  specifier: "@frockbot/plugin-computer",
  contributionSpecifier: "@frockbot/plugin-computer/agent",
  manifest: computerManifest,
  plugin: createComputerAgentPlugin({
    userId: process.env.FROCKBOT_USER_ID?.trim() || "local-user",
    defaultProviderId:
      process.env.FROCKBOT_COMPUTER_PROVIDER?.trim() || "fly-sprite",
  }),
};

export const flySpriteRuntimePackage = {
  specifier: "@frockbot/plugin-fly-sprite",
  contributionSpecifier: "@frockbot/plugin-fly-sprite/provider",
  manifest: flySpriteManifest,
  plugin: flySpriteProviderPlugin,
};

export const desktopComputerRuntimePackages = [
  computerRuntimePackage,
  flySpriteRuntimePackage,
] as const;
