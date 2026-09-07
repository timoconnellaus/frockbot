import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const settingsDefinitionV1: PackageDefinitionV1 = {
  id: "settings",
  displayName: "FrockBot Settings",
  dependencies: ["auth", "shell", "ui-theme"],
  platformOwned: true,
};
