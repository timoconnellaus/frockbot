import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const searchDefinitionV1: PackageDefinitionV1 = {
  id: "search",
  displayName: "Search",
  dependencies: ["flock", "shell", "ui-theme"],
};
