import type { PackageDefinitionV1 } from "@frockbot/core/contracts";
import {
  type AuditUserBackendContribution,
  type AuditUserBackendHost,
} from "@frockbot/app/audit/user";
import {
  type CredentialStorage,
  type CredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
import {
  type BotTemplateUserBackendContribution,
  type TemplateBlobStoreV1,
  type TemplateBotReaderV1,
  type TemplateImportWriterV1,
} from "@frockbot/app/bot-template/user";
export type {
  TemplateBlobStoreV1,
  TemplateBotReaderV1,
  TemplateImportWriterV1,
} from "@frockbot/app/bot-template/user";
import {
  type FlockUserBackendContribution,
  type FlockUserBackendHost,
} from "@frockbot/app/flock/user";
import { type MachineUserBackendContribution } from "@frockbot/app/machine/user";
import type { MachineStorageV1 } from "@frockbot/app/machine/store";
import {
  type SearchUserBackendContribution,
  type SearchUserBackendHost,
} from "@frockbot/app/search/user";
import { type OllamaCloudUserBackendContribution } from "@frockbot/providers/ollama-cloud/user";
import { type FrockAiUserBackendContribution } from "@frockbot/providers/frock-ai/user";
import {
  type UserSettingsBackendContribution,
  type UserSettingsStorage,
} from "@frockbot/app/settings/user";
import {
  FOUNDATION_PACKAGES_V1,
  FOUNDATION_PACKAGE_VERSION_V1,
} from "./packages.js";
import {
  auditUserContribution,
  botTemplateUserContribution,
  createFoundationBackendContributions,
  createFoundationMountedContributionsV1,
  credentialsUserContribution,
  frockAiUserContribution,
  flockUserContribution,
  machineUserContribution,
  ollamaCloudUserContribution,
  searchUserContribution,
  settingsUserContribution,
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
  packages: readonly PackageDefinitionV1[] = FOUNDATION_PACKAGES_V1,
): ReadonlySet<string> {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const packageIds = new Set(
    packages
      .filter(
        (pkg) =>
          pkg.defaultEnablement !== undefined ||
          (pkg.connectionTypes?.length ?? 0) > 0 ||
          (pkg.capabilities?.length ?? 0) > 0,
      )
      .map((pkg) => pkg.id),
  );

  // A `Set` visits what the loop adds, so this is the whole closure.
  for (const packageId of packageIds) {
    for (const dependencyId of byId.get(packageId)?.dependencies ?? []) {
      if (byId.has(dependencyId)) packageIds.add(dependencyId);
    }
  }

  return packageIds;
}

export async function createFoundationUserBackendContributions(host: {
  storage: UserSettingsStorage &
    CredentialStorage &
    FlockUserBackendHost["storage"] &
    MachineStorageV1 & {
      getAlarm?(): Promise<number | null>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
    };
  readSecret(
    name: "CREDENTIAL_KEYRING" | "MACHINE_TOKEN_SECRET" | "BETTER_AUTH_URL",
  ): string | undefined;
  /**
   * The Bot lifecycle seam. Archive and restore are Bot authority, so the
   * User coordinator carries each command to the Bot Durable Object rather
   * than mutating Bot state itself.
   */
  commandBotLifecycle: FlockUserBackendHost["commandBotLifecycle"];
  readBotLifecycle: FlockUserBackendHost["readBotLifecycle"];
  /**
   * The Bot Template seams the adapter owns: the Bot Durable Object reads one
   * export needs, and the immutable blob store the recipe is published into.
   */
  botTemplate: {
    bots: TemplateBotReaderV1;
    blobs: TemplateBlobStoreV1;
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
}): Promise<MountedFoundationUserBackend> {
  const defaultPackageIds = foundationDefaultPackageIds();
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
        availablePackages: FOUNDATION_PACKAGES_V1.map((pkg) => ({
          packageId: pkg.id,
          version: FOUNDATION_PACKAGE_VERSION_V1,
          dependencies: pkg.dependencies ?? [],
          defaultEnablement: pkg.defaultEnablement,
          platformOwned: pkg.platformOwned === true,
          displayName: pkg.displayName,
          capabilities: pkg.capabilities ?? [],
          connectionTypes: pkg.connectionTypes ?? [],
          settings: pkg.settings ?? [],
          installByDefault: defaultPackageIds.has(pkg.id),
        })),
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
        // Existence and display name for a template's Package lines both come
        // from the application's own list; there is no second index to consult.
        availablePackages: FOUNDATION_PACKAGES_V1.map((pkg) => ({
          packageId: pkg.id,
          displayName: pkg.displayName,
        })),
      };
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
      };
    },
    get flock() {
      return {
        storage: host.storage,
        commandBotLifecycle: host.commandBotLifecycle,
        readBotLifecycle: host.readBotLifecycle,
      };
    },
  };

  const mounted = await createFoundationBackendContributions<
    | UserSettingsBackendContribution
    | CredentialUserBackendContribution
    | OllamaCloudUserBackendContribution
    | FrockAiUserBackendContribution
    | FlockUserBackendContribution
    | BotTemplateUserBackendContribution
    | SearchUserBackendContribution
    | AuditUserBackendContribution
    | MachineUserBackendContribution
  >(applicationHost);

  const settings = mounted.get(settingsUserContribution);
  const credentials = mounted.get(credentialsUserContribution);
  const ollama = mounted.get(ollamaCloudUserContribution);
  const frockAi = mounted.get(frockAiUserContribution);
  const flock = mounted.get(flockUserContribution);
  const botTemplate = mounted.get(botTemplateUserContribution);
  const search = mounted.get(searchUserContribution);
  const audit = mounted.get(auditUserContribution);
  const machines = mounted.get(machineUserContribution);
  if (
    !settings ||
    !credentials ||
    !ollama ||
    !frockAi ||
    !flock ||
    !botTemplate ||
    !search ||
    !audit ||
    !machines
  ) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, Frock AI, Flock, Bot Templates, Search, Audit, and Machines User Contributions",
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

  return {
    settings,
    credentials,
    connections,
    flock,
    botTemplate,
    search,
    audit,
    machines,
    async dispose() {
      for (const undo of unregister) undo();
      await mounted.dispose();
    },
  };
}
