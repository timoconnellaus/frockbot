import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const computerDefinitionV1: PackageDefinitionV1 = {
  id: "computer",
  displayName: "Computer",
  dependencies: ["shell", "ui-theme"],
};
