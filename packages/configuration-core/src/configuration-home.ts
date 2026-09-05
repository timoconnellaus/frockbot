import type { PackageSettingDefinition } from "@frockbot/kernel-composition";

export type PackageConfigurationHomeV1 =
  "models" | "connections" | "user-settings" | "none";

/** Only decoded manifest facts participate; installation state is separate. */
export interface ConfigurationHomeFactsV1 {
  capabilities?: readonly { kind: string }[];
  connectionTypes?: readonly unknown[];
  settings?: readonly Pick<PackageSettingDefinition, "role" | "scopes">[];
}

/** One routing policy for backend projections and every renderer. */
export function packageConfigurationHomeV1(
  item: ConfigurationHomeFactsV1,
): PackageConfigurationHomeV1 {
  if (
    item.capabilities?.some((capability) => capability.kind === "model") ||
    item.settings?.some((setting) => setting.role === "model")
  )
    return "models";
  if (item.connectionTypes?.length) return "connections";
  if (item.settings?.some((setting) => setting.scopes.includes("user"))) {
    return "user-settings";
  }
  return "none";
}
