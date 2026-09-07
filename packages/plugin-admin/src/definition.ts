import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const adminDefinitionV1: PackageDefinitionV1 = {
  id: "admin",
  displayName: "Deployment administration",
  dependencies: ["shell", "ui-theme"],
};
