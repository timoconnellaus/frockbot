import flySpriteRuntimePlugin from "@frockbot/plugin-fly-sprite/agent";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";

export const flySpriteRuntimePackage = {
  specifier: "@frockbot/plugin-fly-sprite",
  contributionSpecifier: "@frockbot/plugin-fly-sprite/agent",
  manifest: flySpriteManifest,
  plugin: flySpriteRuntimePlugin,
};
