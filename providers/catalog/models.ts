import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConnectionModelV1 } from "@frockbot/core/connection";
import { withDeadlineV1 } from "@frockbot/core/deadline";
import {
  loadRadiusGatewayConfig,
  getRadiusModelsFromConfig,
} from "@earendil-works/pi-ai/providers/radius-config";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import type { CatalogProviderV1 } from "./registry.js";

export function providerModelsV1(provider: CatalogProviderV1): Model<Api>[] {
  const builtin = getBuiltinProviders().find((id) => id === provider.id);
  return builtin ? getBuiltinModels(builtin) : [];
}
export async function loadProviderModelsV1(
  provider: CatalogProviderV1,
  apiKey: string,
  baseUrl?: string,
): Promise<Model<Api>[]> {
  if (provider.modelSource === "builtin") return providerModelsV1(provider);
  const deadline = withDeadlineV1(15_000);
  try {
    return getRadiusModelsFromConfig(
      provider.id,
      await loadRadiusGatewayConfig(
        baseUrl ?? "https://radius.pi.dev",
        apiKey,
        deadline.signal,
      ),
    );
  } finally {
    deadline.clear();
  }
}
export function connectionModelV1(
  model: Model<Api>,
  source: ConnectionModelV1["source"] = "discovered",
): ConnectionModelV1 {
  return {
    providerModelId: model.id,
    displayName: model.name,
    contextWindow: model.contextWindow,
    // The model's own output ceiling travels with the Connection: a model
    // call may not ask for more than the model can write, and the Plugin
    // transport needs that bound at the Bot, where the catalog is not.
    ...(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
      ? { maxOutputTokens: model.maxTokens }
      : {}),
    capabilities: {
      tools: true,
      vision: model.input.includes("image"),
      reasoning: model.reasoning,
    },
    source,
  };
}
