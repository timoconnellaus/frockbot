import type { ConnectionModelCatalogV1 } from "@frockbot/connection-core";

export const WORKERS_AI_PACKAGE_ID = "provider-workers-ai";
export const WORKERS_AI_CONNECTION_TYPE_ID = "workers-ai-account";
export const WORKERS_AI_CAPABILITY_ID = "workers-ai-models";
export const WORKERS_AI_PROVIDER_TYPE = "workers-ai";
export const WORKERS_AI_CONNECTION_ID = "workers-ai-ambient";
export const WORKERS_AI_CONNECTION_GENERATION = "workers-ai-ambient-v1";
export const WORKERS_AI_DEFAULT_MODEL =
  "@cf/deepseek-ai/deepseek-v4-flash-0731";

const STATIC_CATALOG: ConnectionModelCatalogV1 = {
  schemaVersion: 1,
  generation: "workers-ai-static-v1",
  state: "fresh",
  models: [
    {
      providerModelId: WORKERS_AI_DEFAULT_MODEL,
      displayName: "DeepSeek V4 Flash",
      capabilities: { tools: true, vision: false, reasoning: true },
      source: "discovered",
    },
  ],
};

/** A deployment-safe advisory catalog; it requires no account token or REST call. */
export function workersAiStaticCatalogV1(): ConnectionModelCatalogV1 {
  return structuredClone(STATIC_CATALOG);
}
