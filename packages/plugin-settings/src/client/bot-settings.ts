import type {
  ConnectionView,
  ModelBindingV1,
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

export interface ModelSelectOption {
  value: string;
  label: string;
}

/** The Connections a model can be chosen from: ready, installed, model-capable. */
export function eligibleModelConnections(input: {
  connections: readonly ConnectionView[];
  packages: readonly PackageInstallationView[];
  catalog: readonly PluginCatalogItem[];
}): ConnectionView[] {
  return input.connections.filter((connection) =>
    isModelConnectionEligible({
      connection,
      packages: input.packages,
      catalog: input.catalog,
    }),
  );
}

/** One `<option>` per advertised model, shared by the Bot and User surfaces. */
export function modelSelectOptions(
  connections: readonly ConnectionView[],
): ModelSelectOption[] {
  return connections.flatMap((connection) =>
    (connection.modelCatalog?.models ?? []).map((model) => ({
      value: encodeModelSelection({
        connectionId: connection.connectionId,
        providerModelId: model.providerModelId,
      }),
      label: `${model.displayName} — ${connection.displayName}`,
    })),
  );
}

export function encodeModelSelection(model?: ModelBindingV1): string {
  return model
    ? JSON.stringify([model.connectionId, model.providerModelId])
    : "";
}

/** How a bound model reads in prose, e.g. "Llama 3 — Work". */
export function describeModelBinding(
  model: ModelBindingV1 | undefined,
  connections: readonly ConnectionView[],
): string | undefined {
  if (!model) return undefined;
  const connection = connections.find(
    (candidate) => candidate.connectionId === model.connectionId,
  );
  const catalogModel = connection?.modelCatalog?.models.find(
    (candidate) => candidate.providerModelId === model.providerModelId,
  );
  const name = catalogModel?.displayName ?? model.providerModelId;
  return connection ? `${name} — ${connection.displayName}` : name;
}

/** The inverse of {@link encodeModelSelection}; an empty value means no model. */
export function decodeModelSelection(
  value: string,
): ModelBindingV1 | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("A Connection and model ID are required");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    parsed[0].length === 0 ||
    typeof parsed[1] !== "string" ||
    parsed[1].length === 0
  ) {
    throw new Error("A Connection and model ID are required");
  }
  return { connectionId: parsed[0], providerModelId: parsed[1] };
}
