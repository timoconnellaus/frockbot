import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  createCredentialUserBackendPlugin,
  type CredentialStorage,
  type CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import {
  createBotTemplateUserBackendPlugin,
  type BotTemplateUserBackendContribution,
  type TemplateBlobStoreV1,
  type TemplateBotReaderV1,
} from "@frockbot/plugin-bot-template/user";
export type {
  TemplateBlobStoreV1,
  TemplateBotReaderV1,
} from "@frockbot/plugin-bot-template/user";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
  type FlockUserBackendHost,
} from "@frockbot/plugin-flock/user";
import {
  createPackagePublisherUserPlugin,
  type PackagePublisherUserContribution,
  type PackagePublisherUserHost,
} from "@frockbot/plugin-package-publisher/user";
export type { PackagePublisherUserHost } from "@frockbot/plugin-package-publisher/user";
import {
  createMcpUserBackendPlugin,
  type McpUserBackendContribution,
} from "@frockbot/plugin-mcp/user";
import {
  createSearchUserBackendPlugin,
  type SearchUserBackendContribution,
  type SearchUserBackendHost,
} from "@frockbot/plugin-search/user";
import {
  createOllamaCloudUserBackendPlugin,
  type OllamaCloudUserBackendContribution,
} from "@frockbot/plugin-provider-ollama-cloud/user";
import {
  createUserSettingsBackendPlugin,
  type UserPackageCatalogHost,
  type UserSettingsBackendContribution,
  type UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  type BackendContributionLifecycle,
  createFoundationBackendContributions,
} from "./runtime.js";

export interface FoundationConnectionUserBackendContribution {
  readonly packageId: string;
  executeConnection(accountId: string, input: unknown): Promise<unknown>;
  lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<unknown>;
  leaseModelCredential(input: {
    accountId: string;
    connectionId: string;
    providerModelId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<unknown>;
  settleModelCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void>;
  /**
   * An expiring lease over this Connection's credential for a tool
   * Contribution's mount. Absent on a Package whose Connections carry no
   * credential a Bot ever opens.
   */
  leaseToolCredential?(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<unknown>;
  settleToolCredential?(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void>;
  alarm?(): Promise<void>;
}

export interface MountedFoundationUserBackend {
  settings: UserSettingsBackendContribution;
  credentials: CredentialUserBackendContribution;
  connections: ReadonlyMap<string, FoundationConnectionUserBackendContribution>;
  flock: FlockUserBackendContribution;
  /** The Bot Template share ledger, and the staging command that writes it. */
  botTemplate: BotTemplateUserBackendContribution;
  publisher: PackagePublisherUserContribution;
  /**
   * The MCP Contribution, exposed by name as well as by Connection ownership:
   * the durable server records, the lifecycle commands and the status
   * projection are MCP's own surface, not part of the Connection command
   * protocol every provider answers.
   */
  mcp: McpUserBackendContribution;
  /**
   * The User's transcript index. It is User-scoped state like every other
   * Contribution here, and it is the only one that is a *projection*: the rows
   * are rebuildable from the Bots' own stored runs.
   */
  search: SearchUserBackendContribution;
  dispose(): Promise<void>;
}

export async function createFoundationUserBackendContributions(
  plan: ApplicationPlan,
  host: {
    storage: UserSettingsStorage &
      CredentialStorage &
      FlockUserBackendHost["storage"] & {
        getAlarm?(): Promise<number | null>;
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
    readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
    /**
     * The publication seam: the User Durable Object's own object storage and
     * Worker Loader, which the adapter owns and this application never names.
     */
    packagePublisher: PackagePublisherUserHost;
    /**
     * The Bot lifecycle seam. Archive and restore are Bot authority, so the
     * User coordinator carries each command to the Bot Durable Object rather
     * than mutating Bot state itself.
     */
    commandBotLifecycle: FlockUserBackendHost["commandBotLifecycle"];
    readBotLifecycle: FlockUserBackendHost["readBotLifecycle"];
    /**
     * The remote Package Catalog. Absent when the deployment publishes none,
     * which leaves Package availability exactly as it was: the compiled-in
     * plan.
     */
    catalog?: UserPackageCatalogHost;
    /**
     * The Bot Template seams the adapter owns: the Bot Durable Object reads one
     * export needs, and the immutable blob store the recipe is published into.
     */
    botTemplate: {
      bots: TemplateBotReaderV1;
      blobs: TemplateBlobStoreV1;
      readCatalogDisplayName?(
        generation: string,
        catalogId: string,
      ): Promise<string | undefined>;
    };
    /**
     * The transcript-index seams the adapter owns: this object's own SQL
     * storage, and one page of a Bot's projected rows read from that Bot's
     * Durable Object. The index never invents a row; a rebuild reads them from
     * the authority that holds the runs.
     */
    search: {
      sql: SearchUserBackendHost["sql"];
      projectBotRows: SearchUserBackendHost["projectBotRows"];
      maxRows?: number;
    };
  },
): Promise<MountedFoundationUserBackend> {
  let settings: UserSettingsBackendContribution | undefined;
  let credentials: CredentialUserBackendContribution | undefined;
  let ollama: OllamaCloudUserBackendContribution | undefined;
  let mcp: McpUserBackendContribution | undefined;
  let flock: FlockUserBackendContribution | undefined;
  let botTemplate: BotTemplateUserBackendContribution | undefined;
  let publisher: PackagePublisherUserContribution | undefined;
  let search: SearchUserBackendContribution | undefined;
  const connections = new Map<
    string,
    FoundationConnectionUserBackendContribution
  >();
  const factories = new Map<
    string,
    (
      lifecycle: BackendContributionLifecycle<
        | UserSettingsBackendContribution
        | CredentialUserBackendContribution
        | OllamaCloudUserBackendContribution
        | McpUserBackendContribution
        | FlockUserBackendContribution
        | BotTemplateUserBackendContribution
        | PackagePublisherUserContribution
        | SearchUserBackendContribution
      >,
    ) => Plugin
  >([
    [
      "@frockbot/plugin-settings/user",
      (lifecycle) =>
        createUserSettingsBackendPlugin(
          {
            storage: host.storage,
            availablePackages: plan.packages.map((pkg) => ({
              packageId: pkg.id,
              version: pkg.version,
            })),
            ...(host.catalog ? { catalog: host.catalog } : {}),
          },
          {
            mount(value: UserSettingsBackendContribution) {
              settings = value;
              return lifecycle.mount(value);
            },
          },
        ),
    ],
    [
      "@frockbot/plugin-credentials/user",
      (lifecycle) => {
        const keyring = host.readSecret("CREDENTIAL_KEYRING");
        if (!keyring) {
          throw new Error("Credential Store Contribution is not configured");
        }
        return createCredentialUserBackendPlugin(
          { storage: host.storage, keyring },
          {
            mount(value: CredentialUserBackendContribution) {
              credentials = value;
              return lifecycle.mount(value);
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-provider-ollama-cloud/user",
      (lifecycle) => {
        if (!settings || !credentials) {
          throw new Error(
            "Ollama Cloud requires Settings and Credential Contributions",
          );
        }
        const userSettings = settings;
        return createOllamaCloudUserBackendPlugin(
          { storage: host.storage, settings, credentials },
          {
            mount(value: OllamaCloudUserBackendContribution) {
              ollama = value;
              connections.set(value.packageId, value);
              const unregister =
                userSettings.registerConnectionCommandOwner(value);
              const dispose = lifecycle.mount(value);
              return () => {
                connections.delete(value.packageId);
                unregister();
                dispose();
              };
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-mcp/user",
      (lifecycle) => {
        if (!settings || !credentials) {
          throw new Error("MCP requires Settings and Credential Contributions");
        }
        const userSettings = settings;
        return createMcpUserBackendPlugin(
          { storage: host.storage, settings, credentials },
          {
            mount(value: McpUserBackendContribution) {
              mcp = value;
              connections.set(value.packageId, value);
              const unregister =
                userSettings.registerConnectionCommandOwner(value);
              const dispose = lifecycle.mount(value);
              return () => {
                connections.delete(value.packageId);
                unregister();
                dispose();
              };
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-bot-template/user",
      (lifecycle) => {
        if (!settings) {
          throw new Error("Bot templates require the Settings Contribution");
        }
        return createBotTemplateUserBackendPlugin(
          {
            storage: host.storage,
            settings,
            bots: host.botTemplate.bots,
            blobs: host.botTemplate.blobs,
            ...(host.botTemplate.readCatalogDisplayName
              ? {
                  readCatalogDisplayName:
                    host.botTemplate.readCatalogDisplayName,
                }
              : {}),
          },
          {
            mount(value: BotTemplateUserBackendContribution) {
              botTemplate = value;
              return lifecycle.mount(value);
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-package-publisher/user",
      (lifecycle) =>
        createPackagePublisherUserPlugin(host.packagePublisher, {
          mount(value: PackagePublisherUserContribution) {
            publisher = value;
            return lifecycle.mount(value);
          },
        }),
    ],
    [
      "@frockbot/plugin-search/user",
      (lifecycle) =>
        createSearchUserBackendPlugin(
          {
            ...host.search,
            // The Flock Contribution is the authority for which Bots exist and
            // which are archived, so the index asks it at query time. A
            // lifecycle copied into a row would go stale the moment a Bot is
            // archived, and an archived Bot must leave the default results
            // without waiting for a rebuild.
            readDirectory: async () => {
              if (!flock) {
                throw new Error("Flock User Contribution is unavailable");
              }
              const directory = await flock.listBots();
              const lifecycles = await flock.listBotLifecycles();
              return {
                botIds: directory.bots.map((bot) => bot.botId),
                archivedBotIds: lifecycles.lifecycles
                  .filter((lifecycle) => lifecycle.status === "archived")
                  .map((lifecycle) => lifecycle.botId),
              };
            },
          },
          {
            mount(value: SearchUserBackendContribution) {
              search = value;
              return lifecycle.mount(value);
            },
          },
        ),
    ],
    [
      "@frockbot/plugin-flock/user",
      (lifecycle) =>
        createFlockUserBackendPlugin(
          {
            storage: host.storage,
            commandBotLifecycle: host.commandBotLifecycle,
            readBotLifecycle: host.readBotLifecycle,
            readUserSettings: (storage) => {
              if (!settings) {
                throw new Error("User settings Contribution is unavailable");
              }
              return settings.readSnapshot(storage);
            },
            claimInitialModelBinding: async (storage, input) => {
              if (!settings) {
                throw new Error("User settings Contribution is unavailable");
              }
              const user = await settings.readSnapshot(storage);
              const connection = user.connections.find(
                (candidate) =>
                  candidate.connectionId === input.model.connectionId,
              );
              const installation = user.packages.find(
                (candidate) =>
                  candidate.packageId === connection?.packageId &&
                  candidate.state === "installed",
              );
              const pkg = plan.packages.find(
                (candidate) =>
                  candidate.id === connection?.packageId &&
                  candidate.version === installation?.version,
              );
              const connectionType =
                pkg?.manifest.configuration?.connectionTypes.find(
                  (candidate) => candidate.id === connection?.connectionTypeId,
                );
              const capability = pkg?.manifest.configuration?.capabilities.find(
                (candidate) =>
                  candidate.kind === "model" &&
                  connectionType?.capabilities.includes(candidate.id) &&
                  candidate.connectionTypes.includes(connectionType.id),
              );
              if (
                connection?.state !== "ready" ||
                !installation ||
                !pkg ||
                !connectionType ||
                !capability
              ) {
                return undefined;
              }
              const claimed = await settings.claimConnectionDependency(
                input.userId,
                connection.connectionId,
                input.botId,
                input.generation,
                {
                  schemaVersion: 1,
                  packageId: pkg.id,
                  packageVersion: pkg.version,
                  capabilityId: capability.id,
                  connectionTypeIds: [...capability.connectionTypes],
                },
                storage,
              );
              return claimed
                ? {
                    assignmentId: input.generation,
                    packageId: pkg.id,
                    capabilityId: capability.id,
                    connectionId: connection.connectionId,
                    state: "enabled" as const,
                  }
                : undefined;
            },
          },
          {
            mount(value: FlockUserBackendContribution) {
              flock = value;
              return lifecycle.mount(value);
            },
          },
        ),
    ],
  ]);
  const mounted = await createFoundationBackendContributions<
    | UserSettingsBackendContribution
    | CredentialUserBackendContribution
    | OllamaCloudUserBackendContribution
    | McpUserBackendContribution
    | FlockUserBackendContribution
    | BotTemplateUserBackendContribution
    | PackagePublisherUserContribution
    | SearchUserBackendContribution
  >(plan, {
    backendHost: "user",
    resolve: (specifier, lifecycle) => {
      const factory = factories.get(specifier);
      if (!factory) {
        throw new Error(`Unsupported User Contribution: ${specifier}`);
      }
      return factory(lifecycle);
    },
  });
  if (
    !settings ||
    !credentials ||
    !ollama ||
    !mcp ||
    !flock ||
    !botTemplate ||
    !publisher ||
    !search
  ) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, MCP, Flock, Bot Templates, Search, and Package Publisher User Contributions",
    );
  }
  return {
    settings,
    credentials,
    connections,
    mcp,
    flock,
    botTemplate,
    publisher,
    search,
    dispose: mounted.dispose,
  };
}
