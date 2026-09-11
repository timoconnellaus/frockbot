import type {
  PackageDefinitionV1,
  PackageSettingDefinition,
} from "@frockbot/core/contracts";
import data from "./providers.json";
export const oauthProviderIdsV1 = [
  "openai-codex",
  "github-copilot",
  "kimi-coding",
  "openrouter",
  "xai",
  "radius",
] as const;

export const catalogProvidersV1 = data.filter(
  (provider) => provider.apiKey || provider.id === "openai-codex",
);
export const catalogSettingKeysV1 = [
  "region",
  "account-id",
  "gateway-id",
  "api-version",
] as const;

function setting(
  id: string,
  title: string,
  description?: string,
): PackageSettingDefinition {
  return {
    id,
    schemaVersion: 1,
    scopes: ["connection"],
    schema: {
      type: "string",
      title,
      ...(description ? { description } : {}),
      minLength: 1,
      maxLength: 2048,
    },
  };
}

export const catalogProviderDefinitionsV1: PackageDefinitionV1[] =
  catalogProvidersV1.map<PackageDefinitionV1>((provider) => ({
    id: `provider-${provider.id}`,
    displayName: provider.name,
    capabilities: [
      {
        id: `${provider.id}-models`,
        kind: "model",
        connectionTypes: [
          ...(provider.apiKey ? [`${provider.id}-account`] : []),
          ...(oauthProviderIdsV1.includes(
            provider.id as (typeof oauthProviderIdsV1)[number],
          )
            ? [`${provider.id}-oauth`]
            : []),
        ],
        admission: { turnTypes: ["chat", "automation", "subagent"] },
      },
    ],
    connectionTypes: [
      ...(provider.apiKey
        ? [
            {
              id: `${provider.id}-account`,
              displayName: `${provider.name} account`,
              allowMultiple: true,
              authorization: {
                kind: "api-key" as const,
                driverId: provider.id,
              },
              capabilities: [`${provider.id}-models`],
              settings: [
                setting(
                  "api-base-url",
                  "API base URL",
                  "Optional endpoint override. Azure requires your resource endpoint.",
                ),
                ...(provider.id === "amazon-bedrock"
                  ? [setting("region", "AWS region")]
                  : []),
                ...(provider.id.startsWith("cloudflare-")
                  ? [setting("account-id", "Cloudflare account ID")]
                  : []),
                ...(provider.id === "cloudflare-ai-gateway"
                  ? [setting("gateway-id", "Gateway ID")]
                  : []),
                ...(provider.id === "azure-openai-responses"
                  ? [setting("api-version", "API version")]
                  : []),
              ],
            },
          ]
        : []),
      ...(oauthProviderIdsV1.includes(
        provider.id as (typeof oauthProviderIdsV1)[number],
      )
        ? [
            {
              id: `${provider.id}-oauth`,
              displayName: `${provider.name} sign-in`,
              allowMultiple: true,
              authorization: { kind: "grant" as const, driverId: provider.id },
              capabilities: [`${provider.id}-models`],
            },
          ]
        : []),
    ],
    defaultEnablement: "disabled",
    dependencies: ["credentials", "settings"],
  }));
