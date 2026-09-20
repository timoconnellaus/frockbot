import type {
  PackageDefinitionV1,
  PackageSettingDefinition,
} from "@frockbot/core/contracts";
import { catalogProvidersV1, catalogSettingsV1 } from "./registry.js";

/**
 * One provider this deployment serves only through a Plugin (ADR 0032).
 *
 * A provider on this list keeps its catalog declarations — its connection
 * type, its keyed authorization, its model list, its Package definition — and
 * loses its compiled adapter: the model protocol a Bot's Turn runs through is
 * the installed Plugin's artifact, and no Package registers an `LlmProvider`
 * for it. A Bot whose model names one of these providers and whose account
 * holds no Plugin serving it fails before anything is sent upstream.
 *
 * Everything the host trusts about the contribution is here, compiled, and
 * nothing of it comes from the Plugin: which Plugin id may serve the provider,
 * the Package whose Connections it runs on, the one inference route and
 * endpoint its calls may use, and how the credential is attached. A Plugin
 * declaring the provider is not what grants it anything — this entry is — and
 * the artifact that must be installed is the catalog's own.
 *
 * This is a transitional list, not a policy: the rest of the catalog still
 * runs compiled, and moving one to a Plugin is a deliberate change of this
 * line plus the artifact that serves it.
 */
export interface PluginServedProviderV1 {
  /** The provider type a model binding names. */
  provider: string;
  /** The Package the provider's Connections belong to. */
  packageId: string;
  /** The catalog Plugin that serves it, installed by the account's own command. */
  pluginId: string;
  /**
   * The one route the transport may call, as a path under the endpoint. An
   * inference call and nothing else: the endpoint's billing, file and
   * fine-tuning routes are never reachable through a Plugin's credential.
   */
  route: string;
  /** The provider's API, when the Connection names no endpoint of its own. */
  endpoint: string;
  /**
   * The most output one call may ask this provider for, in tokens. It is the
   * deployment's ceiling and not the model's: a Plugin composes the body, and
   * the size of the call — what it costs — is the host's to bound.
   */
  maxOutputTokens: number;
  auth: { scheme: "bearer" };
}

export const PLUGIN_SERVED_PROVIDERS_V1: readonly PluginServedProviderV1[] = [
  {
    provider: "deepseek",
    packageId: "provider-deepseek",
    pluginId: "deepseek",
    route: "/chat/completions",
    endpoint: "https://api.deepseek.com",
    maxOutputTokens: 8_192,
    auth: { scheme: "bearer" },
  },
];

export const PLUGIN_SERVED_PROVIDER_IDS_V1: readonly string[] =
  PLUGIN_SERVED_PROVIDERS_V1.map((entry) => entry.provider);

/** The provider entry one provider type is served through, when it is one. */
export function pluginServedProviderV1(
  provider: string,
): PluginServedProviderV1 | undefined {
  return PLUGIN_SERVED_PROVIDERS_V1.find(
    (entry) => entry.provider === provider,
  );
}

/**
 * What a person calls a provider: the catalog's own name for it, so product
 * copy says "DeepSeek" rather than the id a wire happens to use.
 */
export function pluginModelProviderDisplayNameV1(provider: string): string {
  return (
    catalogProvidersV1.find((entry) => entry.id === provider)?.name ?? provider
  );
}

/** The providers one Package installs a Plugin for, when it installs any. */
export function pluginServedProvidersForPackageV1(
  packageId: string,
): PluginServedProviderV1[] {
  return PLUGIN_SERVED_PROVIDERS_V1.filter(
    (entry) => entry.packageId === packageId,
  );
}
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
          ...(provider.oauthProviderId ? [`${provider.id}-oauth`] : []),
        ],
        admission: { turnTypes: ["chat", "agent", "automation", "subagent"] },
      },
    ],
    connectionTypes: [
      ...(provider.apiKey
        ? [
            {
              id: `${provider.id}-account`,
              displayName: `${provider.name} account`,
              icon: provider.id,
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
                ...provider.connectionSettings.map((id) => {
                  const metadata = catalogSettingsV1[id];
                  return setting(metadata.id, metadata.title);
                }),
              ],
            },
          ]
        : []),
      ...(provider.oauthProviderId
        ? [
            {
              id: `${provider.id}-oauth`,
              displayName: `${provider.name} sign-in`,
              icon: provider.id,
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
