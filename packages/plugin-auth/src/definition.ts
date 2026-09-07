import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const authDefinitionV1: PackageDefinitionV1 = {
  id: "auth",
  displayName: "Authentication",
  dependencies: ["ui-theme"],
  platformOwned: true,
};
