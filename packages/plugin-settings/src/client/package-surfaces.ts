import type { PackageInstallationView } from "@frockbot/configuration-core";
import type { PluginCatalogItem } from "@frockbot/plugin-shell/shared";

/**
 * Where a Package's configuration lives.
 *
 * Enablement and configuration are separate surfaces: Plugins turns a Package
 * on and off, and whatever the Package declares — provider accounts, external
 * accounts, plain settings — is edited on the surface that owns what it
 * configures. This function is the whole routing table, so a Package that adds
 * a Connection Type or a setting lands somewhere without an edit to a surface.
 */
export type PackageConfigurationHome =
  "models" | "connections" | "user-settings" | "none";

/** A Package that provides a model, whose accounts and catalogs are Models'. */
export function isModelProviderPackage(item: PluginCatalogItem): boolean {
  return item.capabilities.some((capability) => capability.kind === "model");
}

/** A Package a User authorizes an external account against. */
export function declaresConnections(item: PluginCatalogItem): boolean {
  return item.connectionTypes.length > 0;
}

export function packageConfigurationHome(
  item: PluginCatalogItem,
): PackageConfigurationHome {
  if (
    isModelProviderPackage(item) ||
    item.settings?.some((setting) => setting.role === "model")
  )
    return "models";
  if (declaresConnections(item)) return "connections";
  if (
    item.settings?.some(
      (setting) => setting.role !== "model" && setting.scopes.includes("user"),
    )
  )
    return "user-settings";
  return "none";
}

/** The catalog entries one configuration surface is responsible for. */
export function packagesForHome(
  catalog: readonly PluginCatalogItem[],
  home: PackageConfigurationHome,
): PluginCatalogItem[] {
  return catalog.filter((item) => packageConfigurationHome(item) === home);
}

/**
 * The installation row of one Package, whatever state it is in. Absent means
 * the Package is available to this deployment but not installed for the User.
 */
export function packageInstallation(
  packages: readonly PackageInstallationView[],
  packageId: string,
): PackageInstallationView | undefined {
  return packages.find((candidate) => candidate.packageId === packageId);
}

/** Installed and not disabled: the only state in which a Bot may be given it. */
export function isPackageEnabled(
  packages: readonly PackageInstallationView[],
  packageId: string,
): boolean {
  return packageInstallation(packages, packageId)?.state === "installed";
}

/** Installed at all, in any state — including `disabled` and `failed`. */
export function isPackageInstalled(
  packages: readonly PackageInstallationView[],
  packageId: string,
): boolean {
  return packageInstallation(packages, packageId) !== undefined;
}

/**
 * What a configuration surface shows: the Packages it owns that the User has
 * installed and enabled. A disabled Package configures nothing — its knobs are
 * kept, and reappear when it is enabled again in Plugins.
 */
export function configurablePackages(input: {
  catalog: readonly PluginCatalogItem[];
  packages: readonly PackageInstallationView[];
  home: PackageConfigurationHome;
}): PluginCatalogItem[] {
  return packagesForHome(input.catalog, input.home).filter((item) =>
    isPackageEnabled(input.packages, item.packageId),
  );
}

/** The surface name a Plugins row points at, or nothing to configure. */
export function configurationHomeLabel(
  home: PackageConfigurationHome,
): string | undefined {
  if (home === "models") return "Models";
  if (home === "connections") return "Connectors";
  if (home === "user-settings") return "Application settings";
  return undefined;
}
