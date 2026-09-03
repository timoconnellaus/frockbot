import { describe, expect, test } from "bun:test";
import type { PackageInstallationView } from "@frockbot/configuration-core";
import type { PluginCatalogItem } from "@frockbot/plugin-shell/shared";
import {
  configurablePackages,
  configurationHomeLabel,
  isPackageEnabled,
  isPackageInstalled,
  packageConfigurationHome,
  packagesForHome,
} from "./package-surfaces.js";

function catalogItem(
  overrides: Partial<PluginCatalogItem> & { packageId: string },
): PluginCatalogItem {
  return {
    displayName: overrides.packageId,
    version: "0.0.1",
    capabilities: [],
    connectionTypes: [],
    ...overrides,
  };
}

const provider = catalogItem({
  packageId: "provider-ollama-cloud",
  capabilities: [
    { id: "ollama-cloud-models", kind: "model", connectionTypes: ["account"] },
    {
      id: "ollama-cloud-web-search",
      kind: "tool",
      connectionTypes: ["account"],
    },
  ],
  connectionTypes: [
    {
      id: "account",
      displayName: "Ollama Cloud account",
      allowMultiple: true,
      authorizationKind: "api-key",
      capabilities: ["ollama-cloud-models"],
    },
  ],
});

const connector = catalogItem({
  packageId: "composio",
  capabilities: [
    { id: "gmail-tools", kind: "tool", connectionTypes: ["gmail"] },
  ],
  connectionTypes: [
    {
      id: "gmail",
      displayName: "Gmail",
      allowMultiple: false,
      authorizationKind: "grant",
      capabilities: ["gmail-tools"],
    },
  ],
});

const settingsOnly = catalogItem({
  packageId: "image",
  capabilities: [{ id: "image-tools", kind: "tool", connectionTypes: [] }],
  settings: [
    {
      id: "model",
      schemaVersion: 1,
      scopes: ["user"],
      schema: { type: "string", title: "Model" },
    },
  ] as PluginCatalogItem["settings"],
});

const customModels = catalogItem({
  packageId: "custom-models",
  settings: [
    {
      id: "model",
      schemaVersion: 1,
      scopes: ["user", "bot"],
      role: "model",
      schema: {
        type: "object",
        properties: {
          connectionId: { type: "string" },
          providerModelId: { type: "string" },
        },
        required: ["connectionId", "providerModelId"],
        additionalProperties: false,
      },
    },
  ],
});

const plain = catalogItem({
  packageId: "web",
  capabilities: [{ id: "web-tools", kind: "tool", connectionTypes: [] }],
});

const catalog = [provider, connector, settingsOnly, customModels, plain];

function installation(
  packageId: string,
  state: PackageInstallationView["state"],
): PackageInstallationView {
  return { packageId, version: "0.0.1", state };
}

describe("Package configuration homes", () => {
  test("routes every declared Package to exactly one home", () => {
    expect(packageConfigurationHome(provider)).toBe("models");
    expect(packageConfigurationHome(connector)).toBe("connections");
    expect(packageConfigurationHome(settingsOnly)).toBe("user-settings");
    expect(packageConfigurationHome(customModels)).toBe("models");
    // Nothing declared is nothing to configure: the Package appears in Plugins
    // to be enabled and disabled, and on no configuration surface at all.
    expect(packageConfigurationHome(plain)).toBe("none");

    const homed = catalog.flatMap((item) => {
      const home = packageConfigurationHome(item);
      return home === "none" ? [] : [[item.packageId, home] as const];
    });
    expect(homed).toEqual([
      ["provider-ollama-cloud", "models"],
      ["composio", "connections"],
      ["image", "user-settings"],
      ["custom-models", "models"],
    ]);
  });

  test("a model provider that declares Connections is Models', not Connections'", () => {
    expect(packagesForHome(catalog, "models")).toEqual([
      provider,
      customModels,
    ]);
    expect(packagesForHome(catalog, "connections")).toEqual([connector]);
    expect(packagesForHome(catalog, "user-settings")).toEqual([settingsOnly]);
  });

  test("only an installed and enabled Package is configurable", () => {
    const packages = [
      installation("provider-ollama-cloud", "installed"),
      installation("composio", "disabled"),
      installation("image", "failed"),
    ];
    expect(
      configurablePackages({ catalog, packages, home: "models" }).map(
        (item) => item.packageId,
      ),
    ).toEqual(["provider-ollama-cloud"]);
    // A disabled Package keeps its Connections and settings; it just stops
    // being configurable until Plugins enables it again.
    expect(
      configurablePackages({ catalog, packages, home: "connections" }),
    ).toEqual([]);
    expect(
      configurablePackages({ catalog, packages, home: "user-settings" }),
    ).toEqual([]);
    expect(isPackageEnabled(packages, "composio")).toBe(false);
    expect(isPackageInstalled(packages, "composio")).toBe(true);
    expect(isPackageInstalled(packages, "web")).toBe(false);
  });

  test("names the surface a Plugins row points at", () => {
    expect(configurationHomeLabel("models")).toBe("Models");
    expect(configurationHomeLabel("connections")).toBe("Connectors");
    expect(configurationHomeLabel("user-settings")).toBe("Settings");
    expect(configurationHomeLabel("none")).toBeUndefined();
  });
});
