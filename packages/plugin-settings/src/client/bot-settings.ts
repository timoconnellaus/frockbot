import type {
  ConnectionView,
  ModelAssignment,
  PackageInstallationView,
} from "@frockbot/configuration-core";
import type { PluginCatalogItem } from "@frockbot/plugin-shell/shared";

export function isModelConnectionEligible(input: {
  connection: ConnectionView;
  packages: readonly PackageInstallationView[];
  catalog: readonly PluginCatalogItem[];
}): boolean {
  const pkg = input.catalog.find(
    (candidate) => candidate.packageId === input.connection.packageId,
  );
  const connectionType = pkg?.connectionTypes.find(
    (candidate) => candidate.id === input.connection.connectionTypeId,
  );
  return Boolean(
    input.connection.state === "ready" &&
    input.packages.some(
      (candidate) =>
        candidate.packageId === input.connection.packageId &&
        candidate.state === "installed",
    ) &&
    pkg?.capabilities.some(
      (capability) =>
        capability.kind === "model" &&
        connectionType?.capabilities.includes(capability.id),
    ),
  );
}

export function resolveBotSettingsModel(input: {
  current?: ModelAssignment;
  useExactModel: boolean;
  selectedModel: string;
  exactConnectionId: string;
  exactProviderModelId: string;
}): ModelAssignment | undefined {
  if (input.useExactModel) {
    const selected = {
      connectionId: input.exactConnectionId,
      providerModelId: input.exactProviderModelId.trim(),
    };
    if (!selected.connectionId || !selected.providerModelId) {
      throw new Error("A Connection and model ID are required");
    }
    return selected;
  }
  if (!input.selectedModel) return input.current;
  let value: unknown;
  try {
    value = JSON.parse(input.selectedModel);
  } catch {
    throw new Error("A Connection and model ID are required");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    value[0].length === 0 ||
    typeof value[1] !== "string" ||
    value[1].length === 0
  ) {
    throw new Error("A Connection and model ID are required");
  }
  return { connectionId: value[0], providerModelId: value[1] };
}
