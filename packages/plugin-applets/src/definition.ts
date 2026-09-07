import type { PackageDefinitionV1 } from "@frockbot/kernel-contracts";

export const appletsDefinitionV1: PackageDefinitionV1 = {
  id: "applets",
  displayName: "Applets",
  defaultEnablement: "enabled",
  roots: [
    {
      id: "source",
      scope: "user",
    },
  ],
  platformOwned: true,
};
