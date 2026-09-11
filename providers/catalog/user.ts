import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
} from "@frockbot/core/connection";
import { ModelOAuthUserV1 } from "./oauth-user.js";
import {
  oauthProviderIdsV1,
  decodeOAuthTokenV1,
  encodeOAuthTokenV1,
  refreshOAuthV1,
  OAUTH_SECRET_PREFIX,
  type OAuthProviderIdV1,
} from "./oauth-protocol.js";
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";
import {
  modelConnectionLifecycleV1,
  type OllamaCloudUserApplicationHostV1,
  type ModelConnectionClientV1,
  type OllamaUserBackendHost,
} from "../ollama-cloud/user.js";
import { catalogProvidersV1, catalogSettingKeysV1 } from "./definition.js";
import { connectionModelV1, loadProviderModelsV1 } from "./models.js";

function catalogClientV1(
  providerId: string,
  baseUrl?: string,
): ModelConnectionClientV1 {
  return {
    async listModels(apiKey) {
      return (
        await loadProviderModelsV1(
          providerId,
          decodeOAuthTokenV1(apiKey)?.access ?? apiKey,
          baseUrl,
        )
      )
        .slice(0, 90)
        .map((model) => connectionModelV1(model));
    },
    async resolveModel(apiKey, id) {
      const model = (
        await loadProviderModelsV1(
          providerId,
          decodeOAuthTokenV1(apiKey)?.access ?? apiKey,
          baseUrl,
        )
      ).find((candidate) => candidate.id === id);
      if (!model)
        throw new Error(
          `Model "${id}" is absent from the installed ${providerId} catalog`,
        );
      return connectionModelV1(model, "exact-resolution");
    },
    // Saving a key never spends money; the first Turn reports authentication failures.
    async probeInference() {},
  };
}
export function validateCatalogSettingsV1(
  providerId: string,
  settings: Record<string, string>,
): void {
  if (providerId === "azure-openai-responses" && !settings["api-base-url"])
    throw new Error("Azure requires your resource API base URL");
  if (providerId.startsWith("cloudflare-") && !settings["api-base-url"]) {
    if (!/^[a-f0-9]{32}$/i.test(settings["account-id"] ?? ""))
      throw new Error("Cloudflare requires a valid account ID");
    if (
      providerId === "cloudflare-ai-gateway" &&
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(settings["gateway-id"] ?? "")
    )
      throw new Error("Cloudflare AI Gateway requires a gateway ID");
  }
  if (settings.region && !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(settings.region))
    throw new Error("AWS region is invalid");
}

export function createCatalogConnectionOwnerV1(
  provider: (typeof catalogProvidersV1)[number],
  host: OllamaUserBackendHost,
) {
  const Contribution = modelConnectionLifecycleV1({
    packageId: `provider-${provider.id}`,
    displayName: provider.name,
    connectionTypeId: `${provider.id}-account`,
    providerType: provider.id,
    storagePrefix: `catalog-${provider.id}`,
    settingKeys: catalogSettingKeysV1,
    validateSettings: (settings) =>
      validateCatalogSettingsV1(provider.id, settings),
  });
  const keyed = new Contribution({
    ...host,
    createClient: ({ apiBaseUrl }) => catalogClientV1(provider.id, apiBaseUrl),
  });
  const oauthId = oauthProviderIdsV1.find((id) => id === provider.id);
  if (!oauthId) return keyed;
  const OAuthContribution = modelConnectionLifecycleV1({
    packageId: `provider-${provider.id}`,
    displayName: provider.name,
    connectionTypeId: `${provider.id}-oauth`,
    providerType: provider.id,
    storagePrefix: `catalog-oauth-${provider.id}`,
    authorizationKind: "grant",
  });
  const oauth = new OAuthContribution({
    ...host,
    createClient: () => catalogClientV1(provider.id),
    beforeModelLease: async (input) => {
      try {
        await host.credentials.refreshActiveSecret({
          accountId: input.accountId,
          connectionId: input.connectionId,
          packageId: `provider-${provider.id}`,
          generation: input.connectionGeneration,
          needsRefresh: (secret) => {
            const token = decodeOAuthTokenV1(secret);
            if (!token) throw new Error("Invalid OAuth credential");
            return token.expires <= (host.now ?? Date.now)() + 60000;
          },
          refresh: async (secret) =>
            encodeOAuthTokenV1(
              await refreshOAuthV1(
                oauthId,
                decodeOAuthTokenV1(secret)!,
                (host.now ?? Date.now)(),
              ),
            ),
        });
      } catch (error) {
        const current = await host.settings.getConnection(
          input.accountId,
          input.connectionId,
        );
        if (
          current?.generation === input.connectionGeneration &&
          current.state === "ready"
        )
          await host.settings.replaceConnection(
            input.accountId,
            input.connectionId,
            current.generation,
            {
              ...current,
              state: "failed",
              failure:
                "Your sign-in needs renewing. Sign in again to reconnect.",
            },
          );
        throw error;
      }
    },
  });
  const manager = new ModelOAuthUserV1(
    oauthId,
    host,
    (accountId, attemptId, label, token) =>
      oauth.executeConnection(accountId, {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: `oauth-${provider.id}-${attemptId}`,
        packageId: `provider-${provider.id}`,
        connectionTypeId: `${provider.id}-oauth`,
        label,
        apiKey: token,
      }),
  );
  async function owner(accountId: string, connectionId: string) {
    const connection = await host.settings.getConnection(
      accountId,
      connectionId,
    );
    return connection?.connectionTypeId === `${provider.id}-oauth`
      ? oauth
      : keyed;
  }
  return {
    packageId: `provider-${provider.id}`,
    async executeConnection(
      accountId: string,
      input: unknown,
    ): Promise<ConnectionCommandReceiptV1> {
      const command = decodeConnectionCommandV1(input);
      if (command.type === "connection/oauth")
        return manager.execute(accountId, command);
      if (
        command.type === "connection/create-api-key" ||
        command.type === "connection/create"
      ) {
        if (
          !provider.apiKey ||
          command.connectionTypeId !== `${provider.id}-account` ||
          (command.type === "connection/create-api-key" &&
            command.apiKey.startsWith(OAUTH_SECRET_PREFIX))
        )
          throw new Error("Use provider sign-in for this connection");
        return keyed.executeConnection(accountId, command);
      }
      const target = await owner(accountId, command.connectionId);
      if (
        command.type === "connection/rotate-api-key" &&
        (target === oauth || command.apiKey.startsWith(OAUTH_SECRET_PREFIX))
      )
        throw new Error("Reconnect using provider sign-in");
      return target.executeConnection(accountId, command);
    },
    async lookupConnectionCommand(accountId: string, commandId: string) {
      return (
        (await keyed.lookupConnectionCommand(accountId, commandId)) ??
        (await oauth.lookupConnectionCommand(accountId, commandId))
      );
    },
    async leaseModelCredential(
      input: Parameters<typeof keyed.leaseModelCredential>[0],
    ) {
      return (
        await owner(input.accountId, input.connectionId)
      ).leaseModelCredential(input);
    },
    async settleModelCredential(
      input: Parameters<typeof keyed.settleModelCredential>[0],
    ) {
      return keyed.settleModelCredential(input);
    },
    async alarm() {
      await manager.alarm();
      await keyed.alarm();
      await oauth.alarm();
    },
  };
}
export const catalogUserContributionsV1 = catalogProvidersV1.map((provider) =>
  defineUserBackendContribution<
    OllamaCloudUserApplicationHostV1,
    ReturnType<typeof createCatalogConnectionOwnerV1>
  >({
    specifier: `@frockbot/providers/catalog/user/${provider.id}`,
    mount: (host, lifecycle) =>
      lifecycle.mount(
        createCatalogConnectionOwnerV1(provider, host.ollamaCloud),
      ),
  }),
);
