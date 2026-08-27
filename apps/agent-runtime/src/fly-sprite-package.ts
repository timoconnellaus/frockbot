import flySpriteAgentPlugin from "@frockbot/plugin-fly-sprite/agent";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";
import type { FoundationAgentPackage } from "./runtime.js";

export const flySpriteRuntimePackage: FoundationAgentPackage = {
  specifier: "@frockbot/plugin-fly-sprite",
  contributionSpecifier: "@frockbot/plugin-fly-sprite/agent",
  manifest: flySpriteManifest,
  plugin: flySpriteAgentPlugin,
};
