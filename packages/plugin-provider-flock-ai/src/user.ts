import type {
  ConnectionView,
  OperationReceiptV1,
  UserConfigurationCommandV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeConnectionCommandReceiptV1,
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";
import {
  FLOCK_AI_CONNECTION_GENERATION,
  FLOCK_AI_CONNECTION_ID,
  FLOCK_AI_CONNECTION_TYPE_ID,
  FLOCK_AI_DEFAULT_MODEL,
  FLOCK_AI_PACKAGE_ID,
  FLOCK_AI_PROVIDER_TYPE,
  flockAiStaticCatalogV1,
} from "./catalog.js";
import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";

const BOOTSTRAP_KEY = "provider-flock-ai:bootstrap-v1";
const COMMAND_PREFIX = "provider-flock-ai:command:";
const PACKAGE_VERSION = "0.0.1";

interface FlockAiUserSettingsTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

interface FlockAiUserSettingsStorage extends FlockAiUserSettingsTransaction {
  transaction<T>(
    callback: (storage: FlockAiUserSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

interface UserConfigurationReadBootstrap {
  readonly packageId: string;
  bootstrap(userId: string): Promise<void>;
}

interface FlockAiUserSettingsHost {
  read(
    userId: string,
    storage: FlockAiUserSettingsTransaction,
  ): Promise<UserSettingsViewV1>;
  executeConfigurationCommand(
    userId: string,
    command: UserConfigurationCommandV1,
    storage: FlockAiUserSettingsTransaction,
  ): Promise<OperationReceiptV1>;
  createConnection(
    userId: string,
    connection: ConnectionView,
    storage: FlockAiUserSettingsTransaction,
  ): Promise<ConnectionView>;
  replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    connection: ConnectionView,
    storage: FlockAiUserSettingsTransaction,
  ): Promise<ConnectionView>;
  getConnection(
    userId: string,
    connectionId: string,
    storage: FlockAiUserSettingsTransaction,
  ): Promise<ConnectionView | undefined>;
  registerConfigurationReadBootstrap(
    bootstrap: UserConfigurationReadBootstrap,
  ): () => void;
}

interface FlockAiUserBackendHost {
  storage: FlockAiUserSettingsStorage;
  settings: FlockAiUserSettingsHost;
}

interface StoredBootstrapV1 {
  schemaVersion: 1;
  userId: string;
}

interface StoredCommandV1 {
  accountId: string;
  command: ConnectionCommandV1;
  receipt: ConnectionCommandReceiptV1;
}

function decodeBootstrap(input: unknown): StoredBootstrapV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Flock AI bootstrap marker is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    !value.userId
  ) {
    throw new Error("Stored Flock AI bootstrap marker is invalid");
  }
  return { schemaVersion: 1, userId: value.userId };
}

function decodeStoredCommand(input: unknown): StoredCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Flock AI command is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.accountId !== "string" ||
    !value.accountId
  ) {
    throw new Error("Stored Flock AI command is invalid");
  }
  return {
    accountId: value.accountId,
    command: decodeConnectionCommandV1(value.command),
    receipt: decodeConnectionCommandReceiptV1(value.receipt),
  };
}

function ambientConnection(): ConnectionView {
  return {
    connectionId: FLOCK_AI_CONNECTION_ID,
    packageId: FLOCK_AI_PACKAGE_ID,
    connectionTypeId: FLOCK_AI_CONNECTION_TYPE_ID,
    displayName: "Flock AI",
    state: "ready",
    generation: FLOCK_AI_CONNECTION_GENERATION,
    providerType: FLOCK_AI_PROVIDER_TYPE,
    authorization: {
      schemaVersion: 1,
      kind: "ambient-native",
      credential: {
        schemaVersion: 1,
        configured: true,
        source: "ambient-native",
        writable: false,
        generation: FLOCK_AI_CONNECTION_GENERATION,
      },
    },
    modelCatalog: flockAiStaticCatalogV1(),
    safeMetadata: { catalog: "static" },
  };
}

function platformModelResolves(settings: UserSettingsViewV1): boolean {
  const model = settings.platformModel;
  if (!model) return false;
  const connection = settings.connections.find(
    (candidate) => candidate.connectionId === model.connectionId,
  );
  if (!connection || connection.state !== "ready") return false;
  const installed = settings.packages.some(
    (candidate) =>
      candidate.packageId === connection.packageId &&
      candidate.state === "installed",
  );
  return Boolean(
    installed &&
    connection.modelCatalog?.models.some(
      (candidate) => candidate.providerModelId === model.providerModelId,
    ),
  );
}

function flockConnectionNeedsRepair(connection: ConnectionView): boolean {
  return (
    connection.state !== "ready" ||
    connection.providerType !== FLOCK_AI_PROVIDER_TYPE ||
    !connection.modelCatalog?.models.some(
      (candidate) => candidate.providerModelId === FLOCK_AI_DEFAULT_MODEL,
    )
  );
}

function requireApplied(receipt: OperationReceiptV1): void {
  if (receipt.status === "rejected") {
    throw new Error(receipt.failure);
  }
}

export class FlockAiUserBackendContribution implements UserConfigurationReadBootstrap {
  readonly packageId = FLOCK_AI_PACKAGE_ID;

  constructor(private readonly host: FlockAiUserBackendHost) {}

  async bootstrap(userId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const marker = await storage.get<unknown>(BOOTSTRAP_KEY);
      if (marker !== undefined) {
        const decoded = decodeBootstrap(marker);
        if (decoded.userId !== userId) {
          throw new Error("Flock AI bootstrap belongs to another User");
        }
      }

      let settings = await this.host.settings.read(userId, storage);
      const installation = settings.packages.find(
        (candidate) => candidate.packageId === FLOCK_AI_PACKAGE_ID,
      );
      if (
        installation?.state !== "installed" ||
        installation.version !== PACKAGE_VERSION
      ) {
        requireApplied(
          await this.host.settings.executeConfigurationCommand(
            userId,
            {
              schemaVersion: 1,
              type: "user/install-package",
              commandId: `flock-ai-repair-install-v1-${settings.revision}`,
              expectedRevision: settings.revision,
              packageId: FLOCK_AI_PACKAGE_ID,
              version: PACKAGE_VERSION,
            },
            storage,
          ),
        );
      }

      let connection = await this.host.settings.createConnection(
        userId,
        ambientConnection(),
        storage,
      );
      if (
        connection.packageId !== FLOCK_AI_PACKAGE_ID ||
        connection.connectionTypeId !== FLOCK_AI_CONNECTION_TYPE_ID
      ) {
        throw new Error("Flock AI Connection identity is invalid");
      }
      if (flockConnectionNeedsRepair(connection)) {
        await this.host.settings.replaceConnection(
          userId,
          FLOCK_AI_CONNECTION_ID,
          connection.generation,
          ambientConnection(),
          storage,
        );
      }

      settings = await this.host.settings.read(userId, storage);
      if (!platformModelResolves(settings)) {
        requireApplied(
          await this.host.settings.executeConfigurationCommand(
            userId,
            {
              schemaVersion: 1,
              type: "user/set-platform-model",
              commandId: `flock-ai-repair-platform-model-v1-${settings.revision}`,
              expectedRevision: settings.revision,
              model: {
                connectionId: FLOCK_AI_CONNECTION_ID,
                providerModelId: FLOCK_AI_DEFAULT_MODEL,
              },
            },
            storage,
          ),
        );
      }
      if (marker === undefined) {
        await storage.put(BOOTSTRAP_KEY, { schemaVersion: 1, userId });
      }
    });
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const key = `${COMMAND_PREFIX}${command.commandId}`;
    return this.host.storage.transaction(async (storage) => {
      const stored = await storage.get<unknown>(key);
      if (stored !== undefined) {
        const decoded = decodeStoredCommand(stored);
        if (
          decoded.accountId !== accountId ||
          JSON.stringify(decoded.command) !== JSON.stringify(command)
        ) {
          throw new Error("Flock AI command id collision");
        }
        return decoded.receipt;
      }
      const connectionId =
        "connectionId" in command
          ? command.connectionId
          : FLOCK_AI_CONNECTION_ID;
      let status: ConnectionCommandReceiptV1["status"] = "failed";
      const current = await this.host.settings.getConnection(
        accountId,
        connectionId,
        storage,
      );
      if (current?.packageId === FLOCK_AI_PACKAGE_ID) {
        if (command.type === "connection/refresh-models") {
          await this.host.settings.replaceConnection(
            accountId,
            connectionId,
            current.generation,
            { ...current, modelCatalog: flockAiStaticCatalogV1() },
            storage,
          );
          status = "applied";
        } else if (command.type === "connection/update-label") {
          await this.host.settings.replaceConnection(
            accountId,
            connectionId,
            current.generation,
            { ...current, displayName: command.label },
            storage,
          );
          status = "applied";
        }
      }
      const receipt: ConnectionCommandReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        connectionId,
        status,
      };
      await storage.put(key, { accountId, command, receipt });
      return receipt;
    });
  }

  async lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${COMMAND_PREFIX}${commandId}`,
    );
    if (stored === undefined) return undefined;
    const decoded = decodeStoredCommand(stored);
    return decoded.accountId === accountId ? decoded.receipt : undefined;
  }

  async leaseModelCredential(): Promise<never> {
    throw new Error("Flock AI uses its deployment binding, not a credential");
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }
}

export function createFlockAiUserBackendContribution(
  host: FlockAiUserBackendHost,
): FlockAiUserBackendContribution {
  return new FlockAiUserBackendContribution(host);
}

export function createFlockAiUserBackendPlugin(
  host: FlockAiUserBackendHost,
  lifecycle: { mount(value: FlockAiUserBackendContribution): () => void },
): Plugin {
  return () => {
    const contribution = createFlockAiUserBackendContribution(host);
    const unregister =
      host.settings.registerConfigurationReadBootstrap(contribution);
    const dispose = lifecycle.mount(contribution);
    return () => {
      unregister();
      dispose();
    };
  };
}

/**
 * What an application hands this Contribution: the ambient Flock AI Connection, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface FlockAiUserApplicationHostV1 {
  flockAi: FlockAiUserBackendHost;
}

/**
 * The manifest's `user` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const userContribution = defineUserBackendContribution<
  FlockAiUserApplicationHostV1,
  FlockAiUserBackendContribution
>({
  specifier: "@frockbot/plugin-provider-flock-ai/user",
  create: (host, lifecycle) =>
    createFlockAiUserBackendPlugin(host.flockAi, lifecycle),
});
