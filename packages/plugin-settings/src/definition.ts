import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const settingsDefinitionV1: PackageDefinitionV1 = {
  id: "settings",
  displayName: "FrockBot Settings",
  dependencies: ["auth", "shell", "ui-theme"],
  platformOwned: true,
};
