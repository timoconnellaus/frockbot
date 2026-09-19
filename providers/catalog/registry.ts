import data from "./providers.json";

export const oauthProviderIdsV1 = [
  "openai-codex",
  "github-copilot",
  "kimi-coding",
  "openrouter",
  "xai",
  "radius",
] as const;
export type OAuthProviderIdV1 = (typeof oauthProviderIdsV1)[number];

export const catalogSettingKeysV1 = [
  "region",
  "account-id",
  "gateway-id",
  "api-version",
] as const;
export type CatalogSettingKeyV1 = (typeof catalogSettingKeysV1)[number];

export interface CatalogSettingV1 {
  id: CatalogSettingKeyV1;
  title: string;
  environment: string;
}

export const catalogSettingsV1: Record<CatalogSettingKeyV1, CatalogSettingV1> =
  {
    region: {
      id: "region",
      title: "AWS region",
      environment: "AWS_REGION",
    },
    "account-id": {
      id: "account-id",
      title: "Cloudflare account ID",
      environment: "CLOUDFLARE_ACCOUNT_ID",
    },
    "gateway-id": {
      id: "gateway-id",
      title: "Gateway ID",
      environment: "CLOUDFLARE_GATEWAY_ID",
    },
    "api-version": {
      id: "api-version",
      title: "API version",
      environment: "AZURE_OPENAI_API_VERSION",
    },
  };

type CatalogRuntimeAdapterV1 = "pi-ai" | "bedrock";
type CatalogOAuthRequestAuthV1 = "api-key" | "bearer-header";
type CatalogModelSourceV1 = "builtin" | "radius-gateway";
type CatalogSettingsValidationV1 =
  "none" | "azure-endpoint" | "cloudflare-account" | "cloudflare-gateway";

export interface CatalogProviderV1 {
  id: string;
  name: string;
  apiKey: boolean;
  oauthProviderId: OAuthProviderIdV1 | undefined;
  connectionSettings: readonly CatalogSettingKeyV1[];
  runtimeAdapter: CatalogRuntimeAdapterV1;
  oauthRequestAuth: CatalogOAuthRequestAuthV1;
  modelSource: CatalogModelSourceV1;
  settingsValidation: CatalogSettingsValidationV1;
}

type CatalogProviderPolicyV1 = Pick<
  CatalogProviderV1,
  | "connectionSettings"
  | "runtimeAdapter"
  | "oauthRequestAuth"
  | "modelSource"
  | "settingsValidation"
>;

const defaultPolicyV1: CatalogProviderPolicyV1 = {
  connectionSettings: [],
  runtimeAdapter: "pi-ai",
  oauthRequestAuth: "api-key",
  modelSource: "builtin",
  settingsValidation: "none",
};

const providerPoliciesV1: Record<string, Partial<CatalogProviderPolicyV1>> = {
  "amazon-bedrock": {
    connectionSettings: ["region"],
    runtimeAdapter: "bedrock",
  },
  "azure-openai-responses": {
    connectionSettings: ["api-version"],
    settingsValidation: "azure-endpoint",
  },
  "cloudflare-ai-gateway": {
    connectionSettings: ["account-id", "gateway-id"],
    settingsValidation: "cloudflare-gateway",
  },
  "cloudflare-workers-ai": {
    connectionSettings: ["account-id"],
    settingsValidation: "cloudflare-account",
  },
  "kimi-coding": { oauthRequestAuth: "bearer-header" },
  radius: { modelSource: "radius-gateway" },
};

const oauthProviderIds = new Set<string>(oauthProviderIdsV1);
const catalogProviderDataV1 = data.filter(
  (provider) => provider.apiKey || provider.id === "openai-codex",
);
const catalogProviderIdsV1 = new Set(
  catalogProviderDataV1.map((provider) => provider.id),
);
for (const providerId of [
  ...oauthProviderIdsV1,
  ...Object.keys(providerPoliciesV1),
]) {
  if (!catalogProviderIdsV1.has(providerId))
    throw new Error(`Catalog policy references unknown provider ${providerId}`);
}

export const catalogProvidersV1: CatalogProviderV1[] =
  catalogProviderDataV1.map((provider) => ({
    ...provider,
    ...defaultPolicyV1,
    ...providerPoliciesV1[provider.id],
    oauthProviderId: oauthProviderIds.has(provider.id)
      ? (provider.id as OAuthProviderIdV1)
      : undefined,
  }));

export function catalogProviderV1(providerId: string): CatalogProviderV1 {
  const provider = catalogProvidersV1.find(({ id }) => id === providerId);
  if (!provider) throw new Error(`Provider ${providerId} is unavailable`);
  return provider;
}

export function validateCatalogSettingsV1(
  provider: CatalogProviderV1,
  settings: Record<string, string>,
): void {
  if (
    provider.settingsValidation === "azure-endpoint" &&
    !settings["api-base-url"]
  )
    throw new Error("Azure requires your resource API base URL");
  if (
    (provider.settingsValidation === "cloudflare-account" ||
      provider.settingsValidation === "cloudflare-gateway") &&
    !settings["api-base-url"]
  ) {
    if (!/^[a-f0-9]{32}$/i.test(settings["account-id"] ?? ""))
      throw new Error("Cloudflare requires a valid account ID");
    if (
      provider.settingsValidation === "cloudflare-gateway" &&
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(settings["gateway-id"] ?? "")
    )
      throw new Error("Cloudflare AI Gateway requires a gateway ID");
  }
  if (settings.region && !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(settings.region))
    throw new Error("AWS region is invalid");
}

export function catalogRuntimeEnvironmentV1(
  settings: Record<string, unknown> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const setting of Object.values(catalogSettingsV1)) {
    const value = settings?.[setting.id];
    if (typeof value === "string") environment[setting.environment] = value;
  }
  return environment;
}
