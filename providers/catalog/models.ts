import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConnectionModelV1 } from "@frockbot/core/connection";
import {
  loadRadiusGatewayConfig,
  getRadiusModelsFromConfig,
} from "@earendil-works/pi-ai/providers/radius-config";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

export function providerModelsV1(providerId: string): Model<Api>[] {
  const provider = getBuiltinProviders().find((id) => id === providerId);
  return provider ? getBuiltinModels(provider) : [];
}
export async function loadProviderModelsV1(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<Model<Api>[]> {
  if (providerId !== "radius") return providerModelsV1(providerId);
  return getRadiusModelsFromConfig(
    providerId,
    await loadRadiusGatewayConfig(
      baseUrl ?? "https://radius.pi.dev",
      apiKey,
      AbortSignal.timeout(15_000),
    ),
  );
}
export function connectionModelV1(
  model: Model<Api>,
  source: ConnectionModelV1["source"] = "discovered",
): ConnectionModelV1 {
  return {
    providerModelId: model.id,
    displayName: model.name,
    contextWindow: model.contextWindow,
    capabilities: {
      tools: true,
      vision: model.input.includes("image"),
      reasoning: model.reasoning,
    },
    source,
  };
}
