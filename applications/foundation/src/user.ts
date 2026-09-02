import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  createAuditUserBackendPlugin,
  type AuditUserBackendContribution,
  type AuditUserBackendHost,
} from "@frockbot/plugin-audit/user";
import {
  decodeMcpConnectionSettingsV1,
  mcpServerSlugV1,
} from "@frockbot/plugin-mcp/agent";
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
  type TemplateImportWriterV1,
} from "@frockbot/plugin-bot-template/user";
export type {
  TemplateBlobStoreV1,
  TemplateBotReaderV1,
  TemplateImportWriterV1,
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
  createMachineUserBackendPlugin,
  type MachineUserBackendContribution,
} from "@frockbot/plugin-user-machine/user";
import type { MachineStorageV1 } from "@frockbot/plugin-user-machine/store";
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
  createFlockAiUserBackendPlugin,
  type FlockAiUserBackendContribution,
} from "@frockbot/plugin-provider-flock-ai/user";
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
  /**
   * The User's audit table (parity register rows 30 and 30b). Like `search` it
   * is a projection: every row is rebuildable from the Bots' own stored runs.
   */
  audit: AuditUserBackendContribution;
  /**
   * The User's registered machines (parity register rows 48, 49, 57g): the
   * registry, the pairing offers, the command queue and its results. A machine
   * is a User asset, so its authority is here rather than on any Bot.
   */
  machines: MachineUserBackendContribution;
  dispose(): Promise<void>;
}

/**
 * Packages seeded into a new User include every dependency of an explicitly
 * seeded Package. This lets a default-disabled Package be switched on without
 * first repairing invisible dependency rows.
 */
export function foundationDefaultPackageIds(
  plan: Pick<ApplicationPlan, "packages">,
): ReadonlySet<string> {
  const packages = new Map(plan.packages.map((pkg) => [pkg.id, pkg]));
  const packageIds = new Set(
    plan.packages
      .filter(
        (pkg) =>
          pkg.manifest.defaultEnablement !== undefined ||
          (pkg.manifest.configuration?.connectionTypes.length ?? 0) > 0 ||
          (pkg.manifest.configuration?.capabilities.length ?? 0) > 0,
      )
      .map((pkg) => pkg.id),
  );

  for (const packageId of packageIds) {
    const pkg = packages.get(packageId);
    for (const dependencyId of Object.keys(pkg?.manifest.dependencies ?? {})) {
      if (packages.has(dependencyId)) packageIds.add(dependencyId);
    }
  }

  return packageIds;
}

export async function createFoundationUserBackendContributions(
  plan: ApplicationPlan,
  host: {
    storage: UserSettingsStorage &
      CredentialStorage &
      FlockUserBackendHost["storage"] &
      MachineStorageV1 & {
        getAlarm?(): Promise<number | null>;
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
    readSecret(
      name: "CREDENTIAL_KEYRING" | "MACHINE_TOKEN_SECRET",
    ): string | undefined;
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
      /**
       * The import half. The writer carries the importing User's own commands
       * and nothing wider — there is no method on it for a Connection or
       * model binding, so an import cannot create either. `readPublishedShare`
       * routes by the share id's owner half, which is the only way this
       * application ever reaches another User's Durable Object.
       */
      importer?: TemplateImportWriterV1;
      readPublishedShare?(
        shareId: string,
      ): Promise<{ hash: string; document: string } | undefined>;
      readCatalogIds?(generation: string): Promise<readonly string[]>;
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
    /**
     * The audit seams the adapter owns: the same SQL storage, and one page of
     * a Bot's projected entries read from that Bot's Durable Object.
     */
    audit: {
      sql: AuditUserBackendHost["sql"];
      projectBotEntries: AuditUserBackendHost["projectBotEntries"];
      readHostJournalEffectIds?: AuditUserBackendHost["readHostJournalEffectIds"];
      maxRows?: number;
      maxAgeMs?: number;
    };
  },
): Promise<MountedFoundationUserBackend> {
  const defaultPackageIds = foundationDefaultPackageIds(plan);
  let settings: UserSettingsBackendContribution | undefined;
  let credentials: CredentialUserBackendContribution | undefined;
  let ollama: OllamaCloudUserBackendContribution | undefined;
  let flockAi: FlockAiUserBackendContribution | undefined;
  let mcp: McpUserBackendContribution | undefined;
  let flock: FlockUserBackendContribution | undefined;
  let botTemplate: BotTemplateUserBackendContribution | undefined;
  let publisher: PackagePublisherUserContribution | undefined;
  let search: SearchUserBackendContribution | undefined;
  let audit: AuditUserBackendContribution | undefined;
  let machines: MachineUserBackendContribution | undefined;
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
        | FlockAiUserBackendContribution
        | McpUserBackendContribution
        | FlockUserBackendContribution
        | BotTemplateUserBackendContribution
        | PackagePublisherUserContribution
        | SearchUserBackendContribution
        | AuditUserBackendContribution
        | MachineUserBackendContribution
      >,
    ) => Plugin
  >([
    [
      "@frockbot/plugin-settings/user",
      (lifecycle) =>
        createUserSettingsBackendPlugin(
          {
            storage: host.storage,
            // The declared settings travel with the version: the User
            // Durable Object validates a `user/set-package-settings` write
            // against the manifest of the version that User has installed.
            availablePackages: plan.packages.map((pkg) => ({
              packageId: pkg.id,
              version: pkg.version,
              dependencies: pkg.manifest.dependencies,
              defaultEnablement: pkg.manifest.defaultEnablement,
              settings: pkg.manifest.configuration?.settings ?? [],
              installByDefault: defaultPackageIds.has(pkg.id),
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
      "@frockbot/plugin-provider-flock-ai/user",
      (lifecycle) => {
        if (!settings) {
          throw new Error("Flock AI requires the Settings Contribution");
        }
        const userSettings = settings;
        return createFlockAiUserBackendPlugin(
          { storage: host.storage, settings },
          {
            mount(value: FlockAiUserBackendContribution) {
              flockAi = value;
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
            ...(host.botTemplate.importer
              ? { importer: host.botTemplate.importer }
              : {}),
            ...(host.botTemplate.readPublishedShare
              ? { readPublishedShare: host.botTemplate.readPublishedShare }
              : {}),
            ...(host.botTemplate.readCatalogIds
              ? { readCatalogIds: host.botTemplate.readCatalogIds }
              : {}),
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
      "@frockbot/plugin-user-machine/user",
      (lifecycle) =>
        createMachineUserBackendPlugin(
          {
            storage: host.storage,
            readSecret: (name) => host.readSecret(name),
          },
          {
            mount(value: MachineUserBackendContribution) {
              machines = value;
              return lifecycle.mount(value);
            },
          },
        ),
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
      "@frockbot/plugin-audit/user",
      (lifecycle) =>
        createAuditUserBackendPlugin(
          {
            ...host.audit,
            readDirectory: async () => {
              if (!flock) {
                throw new Error("Flock User Contribution is unavailable");
              }
              const directory = await flock.listBots();
              return { botIds: directory.bots.map((bot) => bot.botId) };
            },
            // `mcp__<slug>__<tool>` names the Connection's slug; the host
            // lives in that Connection's settings, which this object owns. The
            // classifier stays pure and answers `remote:<slug>`; the one
            // resolution to `remote:<host>` happens here, on the single path
            // both projection and rebuild take, so the two cannot drift.
            readMcpHosts: async () => {
              const hosts = new Map<string, string>();
              if (!settings) return hosts;
              const snapshot = await settings.readSnapshot(host.storage);
              for (const connection of snapshot.connections) {
                if (connection.packageId !== "mcp") continue;
                try {
                  const url = new URL(
                    decodeMcpConnectionSettingsV1(connection.settings).url,
                  );
                  hosts.set(mcpServerSlugV1(connection), url.host);
                } catch {
                  // A Connection whose settings this build cannot decode
                  // leaves its slug unresolved, which is a less specific row
                  // rather than a wrong one.
                }
              }
              return hosts;
            },
          },
          {
            mount(value: AuditUserBackendContribution) {
              audit = value;
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
    | FlockAiUserBackendContribution
    | McpUserBackendContribution
    | FlockUserBackendContribution
    | BotTemplateUserBackendContribution
    | PackagePublisherUserContribution
    | SearchUserBackendContribution
    | AuditUserBackendContribution
    | MachineUserBackendContribution
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
    !flockAi ||
    !mcp ||
    !flock ||
    !botTemplate ||
    !publisher ||
    !search ||
    !audit ||
    !machines
  ) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, Flock AI, MCP, Flock, Bot Templates, Search, Audit, Machines, and Package Publisher User Contributions",
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
    audit,
    machines,
    dispose: mounted.dispose,
  };
}
