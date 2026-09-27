import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

/** The account's own settings, named for the product. */
export function settingsDefinitionV1(productName: string): PackageDefinitionV1 {
  return {
    id: "settings",
    displayName: `${productName} Settings`,
    dependencies: ["auth", "shell", "ui-theme"],
    platformOwned: true,
  };
}
