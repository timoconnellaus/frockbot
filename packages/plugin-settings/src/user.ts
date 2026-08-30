import {
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeConnectionDependencyRequirementV1,
  decodeOperationReceiptV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  MAX_USER_CONNECTIONS_V1,
  type ConnectionDependencyRequirementV1,
  type ConnectionView,
  type OperationReceiptV1,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { Plugin } from "cordis";

const STATE_KEY = "user-configuration";
const IDENTITY_KEY = "user-id";
const RECEIPT_PREFIX = "configuration-receipt:";
const MAX_CONNECTION_DEPENDENCIES = 256;

type ConnectionDependency = {
  botId: string;
  generation: string;
  packageId: string;
  capabilityId: string;
  claimOrder: number;
  status: "pending" | "acknowledged";
};

interface StoredConfigurationReceipt {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

export interface UserSettingsTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface UserSettingsStorage extends UserSettingsTransaction {
  transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface UserSettingsBackendHost {
  storage: UserSettingsStorage;
  availablePackages: readonly { packageId: string; version: string }[];
}

function initialState(): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "FrockBot user" },
    packages: [],
    connections: [],
  };
}

function decodeStoredConfigurationReceipt(
  input: unknown,
): StoredConfigurationReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored configuration receipt is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => key !== "commandFingerprint" && key !== "receipt",
    ) ||
    typeof value.commandFingerprint !== "string"
  ) {
    throw new Error("Stored configuration receipt is invalid");
  }
  return {
    commandFingerprint: value.commandFingerprint,
    receipt: decodeOperationReceiptV1(value.receipt),
  };
}

function requireMatchingConfigurationReceipt(
  stored: StoredConfigurationReceipt,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}

function connectionDependencies(
  connection: ConnectionView,
): ConnectionDependency[] {
  const value = connection.safeMetadata.dependentAssignments;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const dependency = candidate as Record<string, unknown>;
    if (
      typeof dependency.botId !== "string" ||
      typeof dependency.generation !== "string" ||
      typeof dependency.packageId !== "string" ||
      typeof dependency.capabilityId !== "string" ||
      (dependency.claimOrder !== undefined &&
        (!Number.isSafeInteger(dependency.claimOrder) ||
          (dependency.claimOrder as number) < 0)) ||
      (dependency.status !== "pending" && dependency.status !== "acknowledged")
    ) {
      return [];
    }
    return [
      {
        botId: dependency.botId,
        generation: dependency.generation,
        packageId: dependency.packageId,
        capabilityId: dependency.capabilityId,
        claimOrder:
          dependency.claimOrder === undefined
            ? 0
            : (dependency.claimOrder as number),
        status: dependency.status,
      } satisfies ConnectionDependency,
    ];
  });
}

function withConnectionDependencies(
  connection: ConnectionView,
  dependencies: ConnectionDependency[],
): ConnectionView {
  return {
    ...connection,
    safeMetadata: {
      ...connection.safeMetadata,
      dependentAssignments: dependencies,
    },
  };
}

function applyUserCommand(
  current: UserSettingsViewV1,
  command: UserConfigurationCommandV1,
): UserSettingsViewV1 {
  const revision = current.revision + 1;
  switch (command.type) {
    case "user/update-profile":
      return { ...current, revision, profile: command.profile };
    case "user/set-new-bot-model":
      return { ...current, revision, newBotModelTemplate: command.model };
    case "user/install-package": {
      const existing = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      return {
        ...current,
        revision,
        packages: [
          ...current.packages.filter(
            (pkg) => pkg.packageId !== command.packageId,
          ),
          {
            packageId: command.packageId,
            version: command.version,
            state: existing?.state === "failed" ? "failed" : "installed",
            failure: existing?.failure,
          },
        ],
      };
    }
    case "user/set-package-enabled": {
      const installed = current.packages.some(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (!installed) {
        throw new Error(`Package "${command.packageId}" is not installed`);
      }
      return {
        ...current,
        revision,
        packages: current.packages.map((pkg) =>
          pkg.packageId === command.packageId
            ? {
                ...pkg,
                state: command.enabled ? "installed" : "disabled",
                failure: undefined,
              }
            : pkg,
        ),
      };
    }
  }
}

export class UserSettingsBackendContribution {
  private readonly availablePackages: ReadonlySet<string>;

  constructor(private readonly host: UserSettingsBackendHost) {
    this.availablePackages = new Set(
      host.availablePackages.map(
        ({ packageId, version }) => `${packageId}\u0000${version}`,
      ),
    );
  }

  async readConfiguration(input: unknown): Promise<UserSettingsViewV1> {
    const request = decodeUserConfigurationReadRpcV1(input);
    return this.read(request.userId);
  }

  async executeConfiguration(input: unknown): Promise<OperationReceiptV1> {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    const { command } = request;
    const commandFingerprint = configurationCommandFingerprintV1(command);
    await this.assertIdentity(request.userId);
    return this.host.storage.transaction(async (storage) => {
      const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
      const storedReceipt = await storage.get<unknown>(receiptKey);
      if (storedReceipt !== undefined) {
        return requireMatchingConfigurationReceipt(
          decodeStoredConfigurationReceipt(storedReceipt),
          commandFingerprint,
          command.commandId,
        );
      }
      if (
        command.type === "user/install-package" &&
        !this.availablePackages.has(
          `${command.packageId}\u0000${command.version}`,
        )
      ) {
        throw new Error("Package is not available in this application");
      }
      const storedSettings = await storage.get<unknown>(STATE_KEY);
      const current =
        storedSettings === undefined
          ? initialState()
          : decodeUserSettingsViewV1(storedSettings);
      if (command.type === "user/set-package-enabled" && command.enabled) {
        const installed = current.packages.find(
          (pkg) => pkg.packageId === command.packageId,
        );
        if (
          installed &&
          !this.availablePackages.has(
            `${installed.packageId}\u0000${installed.version}`,
          )
        ) {
          throw new Error("Package is not available in this application");
        }
      }
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const next = applyUserCommand(current, command);
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: next.revision,
        status: "applied",
      };
      await storage.put({
        [STATE_KEY]: next,
        [receiptKey]: { commandFingerprint, receipt },
      });
      return receipt;
    });
  }

  async readSnapshot(
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<UserSettingsViewV1> {
    const stored = await storage.get<unknown>(STATE_KEY);
    return stored === undefined
      ? initialState()
      : decodeUserSettingsViewV1(stored);
  }

  async read(
    userId: string,
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<UserSettingsViewV1> {
    await this.assertIdentity(userId, storage);
    return this.readSnapshot(storage);
  }

  async createConnection(
    userId: string,
    connection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView> {
    const create = async (transaction: UserSettingsTransaction) => {
      await this.assertIdentity(userId, transaction);
      const current = await this.readSnapshot(transaction);
      const existing = current.connections.find(
        (candidate) => candidate.connectionId === connection.connectionId,
      );
      if (existing) return existing;
      const retained = current.connections.filter(
        (candidate) => candidate.state !== "revoked",
      );
      if (retained.length >= MAX_USER_CONNECTIONS_V1) {
        throw new Error("User Connection limit reached");
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: [...retained, structuredClone(connection)],
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      return structuredClone(connection);
    };
    if (storage) return create(storage);
    return this.host.storage.transaction(create);
  }

  async replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    nextConnection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView> {
    const replace = async (transaction: UserSettingsTransaction) => {
      await this.assertIdentity(userId, transaction);
      const current = await this.readSnapshot(transaction);
      const existing = current.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!existing) throw new Error("Connection is unavailable");
      if (existing.generation !== expectedGeneration) {
        throw new Error("Connection generation changed");
      }
      if (nextConnection.connectionId !== connectionId) {
        throw new Error("Connection identity cannot change");
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((candidate) =>
          candidate.connectionId === connectionId
            ? structuredClone(nextConnection)
            : candidate,
        ),
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      return structuredClone(nextConnection);
    };
    if (storage) return replace(storage);
    return this.host.storage.transaction(replace);
  }

  async getConnection(
    userId: string,
    connectionId: string,
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<ConnectionView | undefined> {
    const settings = await this.read(userId, storage);
    const connection = settings.connections.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return connection ? structuredClone(connection) : undefined;
  }

  async isPackageInstalled(
    userId: string,
    packageId: string,
  ): Promise<boolean> {
    const settings = await this.read(userId);
    return settings.packages.some(
      (pkg) => pkg.packageId === packageId && pkg.state === "installed",
    );
  }

  async claimConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
    requirement: ConnectionDependencyRequirementV1,
    storage?: UserSettingsTransaction,
  ): Promise<boolean> {
    const decoded = decodeConnectionDependencyRequirementV1(requirement);
    return this.transitionConnectionDependency(
      userId,
      connectionId,
      (current, settings) => {
        const installation = settings.packages.find(
          (pkg) =>
            pkg.packageId === decoded.packageId &&
            pkg.version === decoded.packageVersion &&
            pkg.state === "installed",
        );
        if (
          !installation ||
          current.state !== "ready" ||
          current.packageId !== decoded.packageId ||
          !decoded.connectionTypeIds.includes(current.connectionTypeId)
        ) {
          return undefined;
        }
        const existing = connectionDependencies(current);
        const replay = existing.find(
          (dependency) =>
            dependency.botId === botId && dependency.generation === generation,
        );
        if (replay) {
          return replay.packageId === decoded.packageId &&
            replay.capabilityId === decoded.capabilityId
            ? current
            : undefined;
        }
        if (existing.length >= MAX_CONNECTION_DEPENDENCIES) return undefined;
        return withConnectionDependencies(current, [
          ...existing,
          {
            botId,
            generation,
            packageId: decoded.packageId,
            capabilityId: decoded.capabilityId,
            claimOrder: settings.revision + 1,
            status: "pending",
          },
        ]);
      },
      storage,
    );
  }

  async acknowledgeConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.host.storage.transaction(async (storage) => {
      await this.assertIdentity(userId, storage);
      const current = await this.readSnapshot(storage);
      const target = current.connections.find(
        (connection) => connection.connectionId === connectionId,
      );
      if (
        !target ||
        target.state === "revoking" ||
        target.state === "revoked"
      ) {
        return false;
      }
      const matched = connectionDependencies(target).find(
        (dependency) =>
          dependency.botId === botId && dependency.generation === generation,
      );
      if (!matched) return false;
      const latestClaimOrder = Math.max(
        ...current.connections.flatMap((connection) =>
          connectionDependencies(connection).flatMap((dependency) =>
            dependency.botId === botId &&
            dependency.packageId === matched.packageId &&
            dependency.capabilityId === matched.capabilityId
              ? [dependency.claimOrder]
              : [],
          ),
        ),
      );
      if (matched.claimOrder < latestClaimOrder) return false;
      if (
        matched.status === "acknowledged" &&
        !current.connections.some((connection) =>
          connectionDependencies(connection).some(
            (dependency) =>
              dependency.botId === botId &&
              dependency.packageId === matched.packageId &&
              dependency.capabilityId === matched.capabilityId &&
              (connection.connectionId !== connectionId ||
                dependency.generation !== generation),
          ),
        )
      ) {
        return true;
      }
      const connections = current.connections.map((connection) => {
        const dependencies = connectionDependencies(connection);
        const nextDependencies = dependencies.flatMap((dependency) => {
          const sameAuthority =
            dependency.botId === botId &&
            dependency.packageId === matched.packageId &&
            dependency.capabilityId === matched.capabilityId;
          if (!sameAuthority) return [dependency];
          if (
            connection.connectionId === connectionId &&
            dependency.generation === generation
          ) {
            return [{ ...dependency, status: "acknowledged" as const }];
          }
          return [];
        });
        return nextDependencies.length === dependencies.length &&
          nextDependencies.every(
            (dependency, index) => dependency === dependencies[index],
          )
          ? connection
          : withConnectionDependencies(connection, nextDependencies);
      });
      await storage.put(STATE_KEY, {
        ...current,
        revision: current.revision + 1,
        connections,
      } satisfies UserSettingsViewV1);
      return true;
    });
  }

  async releaseConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.host.storage.transaction(async (storage) => {
      await this.assertIdentity(userId, storage);
      const current = await this.readSnapshot(storage);
      const target = current.connections.find(
        (connection) => connection.connectionId === connectionId,
      );
      if (!target) return true;
      const existing = connectionDependencies(target);
      const matching = existing.filter(
        (dependency) =>
          dependency.botId === botId && dependency.generation === generation,
      );
      if (matching.length === 0) return true;
      if (matching.some((dependency) => dependency.status !== "acknowledged")) {
        return false;
      }
      const remaining = existing.filter(
        (dependency) =>
          dependency.botId !== botId || dependency.generation !== generation,
      );
      const connections = current.connections.map((connection) =>
        connection.connectionId === connectionId
          ? withConnectionDependencies(connection, remaining)
          : connection,
      );
      await storage.put(STATE_KEY, {
        ...current,
        revision: current.revision + 1,
        connections,
      } satisfies UserSettingsViewV1);
      return true;
    });
  }

  async compensateConnectionDependency(
    userId: string,
    connectionId: string,
    botId: string,
    generation: string,
  ): Promise<boolean> {
    return this.transitionConnectionDependency(
      userId,
      connectionId,
      (current) => {
        const existing = connectionDependencies(current);
        const remaining = existing.filter(
          (dependency) =>
            dependency.botId !== botId ||
            dependency.generation !== generation ||
            dependency.status !== "pending",
        );
        return remaining.length === existing.length
          ? undefined
          : withConnectionDependencies(current, remaining);
      },
    );
  }

  private async transitionConnectionDependency(
    userId: string,
    connectionId: string,
    transition: (
      connection: ConnectionView,
      settings: UserSettingsViewV1,
    ) => ConnectionView | undefined,
    transaction?: UserSettingsTransaction,
  ): Promise<boolean> {
    const apply = async (storage: UserSettingsTransaction) => {
      await this.assertIdentity(userId, storage);
      const current = await this.readSnapshot(storage);
      const connection = current.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!connection) return false;
      const nextConnection = transition(connection, current);
      if (!nextConnection) return false;
      if (nextConnection === connection) return true;
      await storage.put(STATE_KEY, {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((candidate) =>
          candidate.connectionId === connectionId ? nextConnection : candidate,
        ),
      } satisfies UserSettingsViewV1);
      return true;
    };
    return transaction
      ? apply(transaction)
      : this.host.storage.transaction(apply);
  }

  private async assertIdentity(
    userId: string,
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<void> {
    const existing = await storage.get<unknown>(IDENTITY_KEY);
    if (existing !== undefined && typeof existing !== "string") {
      throw new Error("Stored User authority is invalid");
    }
    if (existing && existing !== userId) {
      throw new Error("User authority does not match durable identity");
    }
    if (!existing) await storage.put(IDENTITY_KEY, userId);
  }
}

export function createUserSettingsBackendContribution(
  host: UserSettingsBackendHost,
): UserSettingsBackendContribution {
  return new UserSettingsBackendContribution(host);
}

export function createUserSettingsBackendPlugin(
  host: UserSettingsBackendHost,
  lifecycle: { mount(value: UserSettingsBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createUserSettingsBackendContribution(host));
}
