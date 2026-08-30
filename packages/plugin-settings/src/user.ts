import {
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeOperationReceiptV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  type ConnectionView,
  type OperationReceiptV1,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { Plugin } from "cordis";

const STATE_KEY = "user-configuration";
const IDENTITY_KEY = "user-id";
const RECEIPT_PREFIX = "configuration-receipt:";

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

  async read(userId: string): Promise<UserSettingsViewV1> {
    await this.assertIdentity(userId);
    return this.readSnapshot();
  }

  async createConnection(
    userId: string,
    connection: ConnectionView,
  ): Promise<ConnectionView> {
    await this.assertIdentity(userId);
    return this.host.storage.transaction(async (storage) => {
      const current = await this.readSnapshot(storage);
      const existing = current.connections.find(
        (candidate) => candidate.connectionId === connection.connectionId,
      );
      if (existing) return existing;
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: [...current.connections, structuredClone(connection)],
      } satisfies UserSettingsViewV1;
      await storage.put(STATE_KEY, next);
      return structuredClone(connection);
    });
  }

  async replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    nextConnection: ConnectionView,
  ): Promise<ConnectionView> {
    await this.assertIdentity(userId);
    return this.host.storage.transaction(async (storage) => {
      const current = await this.readSnapshot(storage);
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
      await storage.put(STATE_KEY, next);
      return structuredClone(nextConnection);
    });
  }

  async getConnection(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionView | undefined> {
    const settings = await this.read(userId);
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

  private async assertIdentity(userId: string): Promise<void> {
    const existing = await this.host.storage.get<unknown>(IDENTITY_KEY);
    if (existing !== undefined && typeof existing !== "string") {
      throw new Error("Stored User authority is invalid");
    }
    if (existing && existing !== userId) {
      throw new Error("User authority does not match durable identity");
    }
    if (!existing) await this.host.storage.put(IDENTITY_KEY, userId);
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
