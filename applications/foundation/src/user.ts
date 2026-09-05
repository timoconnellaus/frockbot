import type { ComposioUserService } from "@frockbot/plugin-composio/user";
import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  type AuditUserBackendContribution,
  type AuditUserBackendHost,
} from "@frockbot/plugin-audit/user";
import {
  type BillingUserBackendContribution,
  type BillingUserBackendHostV1,
} from "@frockbot/plugin-billing/user";
import {
  decodeMcpConnectionSettingsV1,
  mcpServerSlugV1,
} from "@frockbot/plugin-mcp/agent";
import {
  type CredentialStorage,
  type CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import {
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
  type FlockUserBackendContribution,
  type FlockUserBackendHost,
} from "@frockbot/plugin-flock/user";
import {
  type PackagePublisherUserContribution,
  type PackagePublisherUserHost,
} from "@frockbot/plugin-package-publisher/user";
export type { PackagePublisherUserHost } from "@frockbot/plugin-package-publisher/user";
import { type McpUserBackendContribution } from "@frockbot/plugin-mcp/user";
import { type MachineUserBackendContribution } from "@frockbot/plugin-user-machine/user";
import type { MachineStorageV1 } from "@frockbot/plugin-user-machine/store";
import {
  type SearchUserBackendContribution,
  type SearchUserBackendHost,
} from "@frockbot/plugin-search/user";
import { type OllamaCloudUserBackendContribution } from "@frockbot/plugin-provider-ollama-cloud/user";
import { type FrockAiUserBackendContribution } from "@frockbot/plugin-provider-frock-ai/user";
import {
  type VoiceUserBackendContributionV1,
  type VoiceUserBackendHostV1,
} from "@frockbot/plugin-voice/user";
import {
  type UserPackageCatalogHost,
  type UserSettingsBackendContribution,
  type UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import { isPlatformOwnedPackageV1 } from "./runtime.js";
import {
  auditUserContribution,
  billingUserContribution,
  botTemplateUserContribution,
  createFoundationBackendContributions,
  createFoundationMountedContributionsV1,
  credentialsUserContribution,
  frockAiUserContribution,
  flockUserContribution,
  machineUserContribution,
  composioUserContribution,
  mcpUserContribution,
  ollamaCloudUserContribution,
  packagePublisherUserContribution,
  searchUserContribution,
  settingsUserContribution,
  voiceUserContribution,
  type FoundationUserBackendHostV1,
} from "./contributions.js";

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

/**
 * A Connection command owner is recognized by the protocol it answers, not by
 * which Package it is: any User Contribution that executes Connection commands
 * and leases model credentials owns its Package's Connections, and Settings
 * routes those commands to it.
 */
function isConnectionCommandOwner(
  contribution: unknown,
): contribution is FoundationConnectionUserBackendContribution {
  const candidate = contribution as
    Partial<FoundationConnectionUserBackendContribution> | undefined;
  return (
    typeof candidate?.packageId === "string" &&
    typeof candidate.executeConnection === "function" &&
    typeof candidate.lookupConnectionCommand === "function" &&
    typeof candidate.leaseModelCredential === "function" &&
    typeof candidate.settleModelCredential === "function"
  );
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
  composio?: ComposioUserService;
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
  /** Account-wide model and voice usage, priced when each entry is written. */
  billing: BillingUserBackendContribution;
  /**
   * The User's registered machines (parity register rows 48, 49, 57g): the
   * registry, the pairing offers, the command queue and its results. A machine
   * is a User asset, so its authority is here rather than on any Bot.
   */
  machines: MachineUserBackendContribution;
  /** Voice's User-scoped ledger and bounded read-only tool executor. */
  voice: VoiceUserBackendContributionV1;
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
      name:
        | "CREDENTIAL_KEYRING"
        | "MACHINE_TOKEN_SECRET"
        | "COMPOSIO_API_KEY"
        | "BETTER_AUTH_URL",
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
    /** Durable Voice ledger storage and reads over User-owned Bot state. */
    voice: VoiceUserBackendHostV1;
    billing: BillingUserBackendHostV1;
  },
): Promise<MountedFoundationUserBackend> {
  const defaultPackageIds = foundationDefaultPackageIds(plan);
  const connections = new Map<
    string,
    FoundationConnectionUserBackendContribution
  >();
  // Where each descriptor's mounted value lands as the mount runs, so a
  // Contribution that needs an earlier one names the table entry it imported
  // rather than a specifier string.
  const mountedContributions = createFoundationMountedContributionsV1();

  function requireFlock(): FlockUserBackendContribution {
    const flock = mountedContributions.get(flockUserContribution);
    if (!flock) throw new Error("Flock User Contribution is unavailable");
    return flock;
  }

  /**
   * One wide host object, one slice per Package, each behind a getter.
   *
   * The getters are what make a table possible at all: a slice is built when
   * its Contribution mounts, so Ollama Cloud can be handed the Settings and
   * Credential Contributions that the plan mounted before it without this
   * module deciding the order or naming the Package.
   */
  const applicationHost: FoundationUserBackendHostV1 = {
    backendHost: "user",
    mountedContributions,
    get settings() {
      return {
        storage: host.storage,
        // The declared settings travel with the version: the User
        // Durable Object validates a `user/set-package-settings` write
        // against the manifest of the version that User has installed.
        availablePackages: plan.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          dependencies: pkg.manifest.dependencies,
          defaultEnablement: pkg.manifest.defaultEnablement,
          platformOwned: isPlatformOwnedPackageV1(
            pkg.manifest,
            defaultPackageIds.has(pkg.id),
          ),
          settings: pkg.manifest.configuration?.settings ?? [],
          installByDefault: defaultPackageIds.has(pkg.id),
        })),
        ...(host.catalog ? { catalog: host.catalog } : {}),
      };
    },
    get credentials() {
      const keyring = host.readSecret("CREDENTIAL_KEYRING");
      if (!keyring) {
        throw new Error("Credential Store Contribution is not configured");
      }
      return { storage: host.storage, keyring };
    },
    get ollamaCloud() {
      const settings = mountedContributions.get(settingsUserContribution);
      const credentials = mountedContributions.get(credentialsUserContribution);
      if (!settings || !credentials) {
        throw new Error(
          "Ollama Cloud requires Settings and Credential Contributions",
        );
      }
      return { storage: host.storage, settings, credentials };
    },
    get frockAi() {
      const settings = mountedContributions.get(settingsUserContribution);
      if (!settings) {
        throw new Error("Frock AI requires the Settings Contribution");
      }
      return { storage: host.storage, settings };
    },
    get composio() {
      const settings = mountedContributions.get(settingsUserContribution);
      if (!settings) throw new Error("Connected apps require Settings");
      return {
        storage: host.storage,
        settings,
        apiKey: host.readSecret("COMPOSIO_API_KEY"),
        callbackBaseUrl:
          host.readSecret("BETTER_AUTH_URL") ?? "http://localhost:8787",
      };
    },
    get mcp() {
      const settings = mountedContributions.get(settingsUserContribution);
      const credentials = mountedContributions.get(credentialsUserContribution);
      if (!settings || !credentials) {
        throw new Error("MCP requires Settings and Credential Contributions");
      }
      return { storage: host.storage, settings, credentials };
    },
    get botTemplate() {
      const settings = mountedContributions.get(settingsUserContribution);
      if (!settings) {
        throw new Error("Bot templates require the Settings Contribution");
      }
      return {
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
              readCatalogDisplayName: host.botTemplate.readCatalogDisplayName,
            }
          : {}),
      };
    },
    get packagePublisher() {
      return host.packagePublisher;
    },
    get machines() {
      return {
        storage: host.storage,
        readSecret: (name: "MACHINE_TOKEN_SECRET") => host.readSecret(name),
      };
    },
    get search() {
      return {
        ...host.search,
        // The Flock Contribution is the authority for which Bots exist and
        // which are archived, so the index asks it at query time. A
        // lifecycle copied into a row would go stale the moment a Bot is
        // archived, and an archived Bot must leave the default results
        // without waiting for a rebuild.
        readDirectory: async () => {
          const flock = requireFlock();
          const directory = await flock.listBots();
          const lifecycles = await flock.listBotLifecycles();
          return {
            botIds: directory.bots.map((bot) => bot.botId),
            archivedBotIds: lifecycles.lifecycles
              .filter((lifecycle) => lifecycle.status === "archived")
              .map((lifecycle) => lifecycle.botId),
          };
        },
      };
    },
    get audit() {
      return {
        ...host.audit,
        readDirectory: async () => {
          const flock = requireFlock();
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
          const settings = mountedContributions.get(settingsUserContribution);
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
      };
    },
    get billing() {
      return host.billing;
    },
    get flock() {
      return {
        storage: host.storage,
        commandBotLifecycle: host.commandBotLifecycle,
        readBotLifecycle: host.readBotLifecycle,
      };
    },
    get voice() {
      return host.voice;
    },
  };

  const mounted = await createFoundationBackendContributions<
    | UserSettingsBackendContribution
    | CredentialUserBackendContribution
    | OllamaCloudUserBackendContribution
    | FrockAiUserBackendContribution
    | ComposioUserService
    | McpUserBackendContribution
    | FlockUserBackendContribution
    | BotTemplateUserBackendContribution
    | PackagePublisherUserContribution
    | SearchUserBackendContribution
    | AuditUserBackendContribution
    | BillingUserBackendContribution
    | MachineUserBackendContribution
    | VoiceUserBackendContributionV1
  >(plan, applicationHost);

  const settings = mounted.get(settingsUserContribution);
  const credentials = mounted.get(credentialsUserContribution);
  const ollama = mounted.get(ollamaCloudUserContribution);
  const frockAi = mounted.get(frockAiUserContribution);
  const composio = mounted.get(composioUserContribution);
  const mcp = mounted.get(mcpUserContribution);
  const flock = mounted.get(flockUserContribution);
  const botTemplate = mounted.get(botTemplateUserContribution);
  const publisher = mounted.get(packagePublisherUserContribution);
  const search = mounted.get(searchUserContribution);
  const audit = mounted.get(auditUserContribution);
  const billing = mounted.get(billingUserContribution);
  const machines = mounted.get(machineUserContribution);
  const voice = mounted.get(voiceUserContribution);
  if (
    !settings ||
    !credentials ||
    !ollama ||
    !frockAi ||
    !mcp ||
    !flock ||
    !botTemplate ||
    !publisher ||
    !search ||
    !audit ||
    !billing ||
    !machines ||
    !voice
  ) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, Frock AI, MCP, Flock, Bot Templates, Search, Audit, Billing, Machines, Voice, and Package Publisher User Contributions",
    );
  }

  /**
   * A Connection command owner is recognized by the protocol it answers, not
   * by which Package it is: any Contribution that executes Connection commands
   * and leases model credentials owns its Package's Connections.
   */
  const unregister = (mounted.contributions as readonly unknown[])
    .filter(isConnectionCommandOwner)
    .map((contribution) => {
      connections.set(contribution.packageId, contribution);
      const dispose = settings.registerConnectionCommandOwner(contribution);
      return () => {
        connections.delete(contribution.packageId);
        dispose();
      };
    });

  if (composio)
    unregister.push(
      settings.registerConfigurationReadBootstrap({
        packageId: "composio",
        bootstrap: (userId) => composio.reconcile(userId),
      }),
    );

  return {
    settings,
    credentials,
    connections,
    mcp,
    composio,
    flock,
    botTemplate,
    publisher,
    search,
    audit,
    billing,
    machines,
    voice,
    async dispose() {
      for (const undo of unregister) undo();
      await mounted.dispose();
    },
  };
}
