import {
  type AuditUserBackendContribution,
  type AuditUserBackendHost,
} from "@frockbot/app/audit/user";
import {
  type CredentialStorage,
  type CredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
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
import { type ConnectUserBackendContribution } from "@frockbot/app/connect/user";
import { type McpUserBackendContribution } from "@frockbot/app/mcp/user";
import { type OllamaCloudUserBackendContribution } from "@frockbot/providers/ollama-cloud/user";
import { type FrockAiUserBackendContribution } from "@frockbot/providers/frock-ai/user";
import {
  type UserSettingsBackendContribution,
  type UserSettingsStorage,
} from "@frockbot/app/settings/user";
import {
  FOUNDATION_PACKAGE_CATALOG_V1,
  FOUNDATION_PACKAGE_VERSION_V1,
} from "./packages.js";
import type {
  PackageCatalogIndexV1,
  PackageDefinitionV1,
} from "@frockbot/core/contracts";
import {
  auditUserContribution,
  createFoundationBackendContributions,
  createFoundationMountedContributionsV1,
  credentialsUserContribution,
  frockAiUserContribution,
  flockUserContribution,
  machineUserContribution,
  mcpUserContribution,
  ollamaCloudUserContribution,
  connectUserContribution,
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
  /**
   * A Turn's read of this Connection's tool directory, or of one tool's
   * schema. Absent on a Package whose Connections carry no tools.
   */
  readToolCatalog?(input: {
    userId: string;
    connectionId: string;
    generation: string;
    toolName?: string;
  }): Promise<unknown>;
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
  /** Connected apps: Connections, trigger instances, and event mapping. */
  connect: ConnectUserBackendContribution;
  /** Remote MCP servers: their credentials, sign-ins and tool directories. */
  mcp: McpUserBackendContribution;
  dispose(): Promise<void>;
}

/**
 * Packages seeded into a new User include every dependency of an explicitly
 * seeded Package. This lets a default-disabled Package be switched on without
 * first repairing invisible dependency rows.
 */
export function foundationDefaultPackageIds(
  catalog: PackageCatalogIndexV1<PackageDefinitionV1> = FOUNDATION_PACKAGE_CATALOG_V1,
): ReadonlySet<string> {
  const packageIds = new Set(
    catalog.entries
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
    for (const dependencyId of catalog.get(packageId)?.dependencies ?? []) {
      if (catalog.has(dependencyId)) packageIds.add(dependencyId);
    }
  }

  return packageIds;
}

export async function createFoundationUserBackendContributions(host: {
  storage: UserSettingsStorage &
    CredentialStorage &
    FlockUserBackendHost["storage"] &
    MachineStorageV1 & {
      delete(key: string): Promise<boolean>;
      list<T>(options: { prefix: string }): Promise<Map<string, T>>;
      getAlarm?(): Promise<number | null>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
    };
  readSecret(
    name:
      | "CREDENTIAL_KEYRING"
      | "MACHINE_TOKEN_SECRET"
      | "BETTER_AUTH_URL"
      | "COMPOSIO_API_KEY",
  ): string | undefined;
  /**
   * The Bot lifecycle seam. Archive and restore are Bot authority, so the
   * User coordinator carries each command to the Bot Durable Object rather
   * than mutating Bot state itself.
   */
  commandBotLifecycle: FlockUserBackendHost["commandBotLifecycle"];
  readBotLifecycle: FlockUserBackendHost["readBotLifecycle"];
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
        availablePackages: FOUNDATION_PACKAGE_CATALOG_V1.entries.map((pkg) => ({
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
    get mcp() {
      const settings = mountedContributions.get(settingsUserContribution);
      const credentials = mountedContributions.get(credentialsUserContribution);
      if (!settings || !credentials) {
        throw new Error("MCP servers require Settings and Credentials");
      }
      // A sign-in's state is signed under the keyring, so the callback can
      // refuse a forged one before it reaches this object.
      const keyring = host.readSecret("CREDENTIAL_KEYRING");
      return {
        storage: host.storage,
        settings,
        credentials,
        ...(keyring ? { keyring } : {}),
      };
    },
    get connect() {
      const settings = mountedContributions.get(settingsUserContribution);
      if (!settings) {
        throw new Error("Connected apps require the Settings Contribution");
      }
      const apiKey = host.readSecret("COMPOSIO_API_KEY");
      const callbackBaseUrl = host.readSecret("BETTER_AUTH_URL");
      return {
        storage: host.storage,
        settings,
        ...(apiKey ? { apiKey } : {}),
        ...(callbackBaseUrl ? { callbackBaseUrl } : {}),
      };
    },
    get modelConnections() {
      const settings = mountedContributions.get(settingsUserContribution);
      const credentials = mountedContributions.get(credentialsUserContribution);
      if (!settings || !credentials) {
        throw new Error("Model Connections require Settings and Credentials");
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
        // An MCP call is audited against its server's namespace; the User's
        // servers are what say which host that is.
        readMcpHosts: async () =>
          (await mountedContributions.get(mcpUserContribution)?.readHosts()) ??
          new Map<string, string>(),
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
    | ConnectUserBackendContribution
    | McpUserBackendContribution
    | OllamaCloudUserBackendContribution
    | FrockAiUserBackendContribution
    | FlockUserBackendContribution
    | SearchUserBackendContribution
    | AuditUserBackendContribution
    | MachineUserBackendContribution
  >(applicationHost);

  const settings = mounted.get(settingsUserContribution);
  const credentials = mounted.get(credentialsUserContribution);
  const ollama = mounted.get(ollamaCloudUserContribution);
  const frockAi = mounted.get(frockAiUserContribution);
  const flock = mounted.get(flockUserContribution);
  const search = mounted.get(searchUserContribution);
  const audit = mounted.get(auditUserContribution);
  const machines = mounted.get(machineUserContribution);
  const connect = mounted.get(connectUserContribution);
  const mcp = mounted.get(mcpUserContribution);
  if (
    !settings ||
    !credentials ||
    !ollama ||
    !frockAi ||
    !flock ||
    !search ||
    !audit ||
    !machines ||
    !connect ||
    !mcp
  ) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, Frock AI, Flock, Search, Audit, Machines, Connected apps and MCP servers User Contributions",
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
    search,
    audit,
    machines,
    connect,
    mcp,
    async dispose() {
      for (const undo of unregister) undo();
      await mounted.dispose();
    },
  };
}
