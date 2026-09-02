import type { ConnectionModelCatalogV1 } from "@frockbot/connection-core";

export const FLOCK_AI_PACKAGE_ID = "provider-flock-ai";
export const FLOCK_AI_CONNECTION_TYPE_ID = "flock-ai-account";
export const FLOCK_AI_CAPABILITY_ID = "flock-ai-models";
export const FLOCK_AI_PROVIDER_TYPE = "flock-ai";
export const FLOCK_AI_CONNECTION_ID = "flock-ai-ambient";
export const FLOCK_AI_CONNECTION_GENERATION = "flock-ai-ambient-v1";
export const FLOCK_AI_DEFAULT_MODEL = "@flock/auto";
export const FLOCK_AI_DEFAULT_AUTO_ROUTE = "flock-auto";

const WORKERS_AI_TEXT_MODELS = [
  {
    workersAiModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    displayName: "DeepSeek V4 Flash",
    capabilities: { tools: true, vision: false, reasoning: true },
  },
] as const;

export function flockModelIdForWorkersAiIdV1(id: string): string {
  if (!id.startsWith("@cf/") || id.length === "@cf/".length) {
    throw new Error(`Workers AI model id "${id}" must start with "@cf/"`);
  }
  return `@flock/${id.slice("@cf/".length)}`;
}

export function workersAiModelIdForFlockIdV1(id: string): string {
  if (!id.startsWith("@flock/") || id.length === "@flock/".length) {
    throw new Error(`Flock AI model id "${id}" must start with "@flock/"`);
  }
  if (id === FLOCK_AI_DEFAULT_MODEL) {
    throw new Error("Flock AI Auto does not name a Workers AI model");
  }
  return `@cf/${id.slice("@flock/".length)}`;
}

export function gatewayModelForFlockIdV1(
  id: string,
  autoRoute = FLOCK_AI_DEFAULT_AUTO_ROUTE,
): string {
  if (!id.startsWith("@flock/") || id.length === "@flock/".length) {
    throw new Error(`Flock AI model id "${id}" must start with "@flock/"`);
  }
  if (id === FLOCK_AI_DEFAULT_MODEL) {
    if (!/^[A-Za-z0-9-]+$/.test(autoRoute)) {
      throw new Error(`Flock AI Auto route "${autoRoute}" is invalid`);
    }
    return `dynamic/${autoRoute}`;
  }
  return `workers-ai/${workersAiModelIdForFlockIdV1(id)}`;
}

const STATIC_CATALOG: ConnectionModelCatalogV1 = {
  schemaVersion: 1,
  generation: "flock-ai-static-v1",
  state: "fresh",
  models: [
    {
      providerModelId: FLOCK_AI_DEFAULT_MODEL,
      displayName: "Auto (recommended)",
      capabilities: { tools: true, vision: false, reasoning: true },
      source: "discovered",
    },
    ...WORKERS_AI_TEXT_MODELS.map((model) => ({
      providerModelId: flockModelIdForWorkersAiIdV1(model.workersAiModelId),
      displayName: model.displayName,
      capabilities: model.capabilities,
      source: "discovered" as const,
    })),
  ],
};

/** A deployment-safe advisory catalog; it requires no account token or REST call. */
export function flockAiStaticCatalogV1(): ConnectionModelCatalogV1 {
  return structuredClone(STATIC_CATALOG);
}
