import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const auditDefinitionV1: PackageDefinitionV1 = {
  id: "audit",
  displayName: "Audit",
  dependencies: ["flock", "shell", "ui-theme"],
};
