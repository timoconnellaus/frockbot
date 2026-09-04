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
  FROCK_AI_CONNECTION_GENERATION,
  FROCK_AI_CONNECTION_ID,
  FROCK_AI_CONNECTION_TYPE_ID,
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_PACKAGE_ID,
  FROCK_AI_PROVIDER_TYPE,
  frockAiStaticCatalogV1,
} from "./catalog.js";
import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";

// Durable storage keys. They read `flock-` because they are already written in
// every existing User's Durable Object; see the note in `catalog.ts`.
const BOOTSTRAP_KEY = "provider-flock-ai:bootstrap-v1";
const COMMAND_PREFIX = "provider-flock-ai:command:";
const PACKAGE_VERSION = "0.0.1";

interface FrockAiUserSettingsTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

interface FrockAiUserSettingsStorage extends FrockAiUserSettingsTransaction {
  transaction<T>(
    callback: (storage: FrockAiUserSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

interface UserConfigurationReadBootstrap {
  readonly packageId: string;
  bootstrap(userId: string): Promise<void>;
}

interface FrockAiUserSettingsHost {
  read(
    userId: string,
    storage: FrockAiUserSettingsTransaction,
  ): Promise<UserSettingsViewV1>;
  executeConfigurationCommand(
    userId: string,
    command: UserConfigurationCommandV1,
    storage: FrockAiUserSettingsTransaction,
  ): Promise<OperationReceiptV1>;
  createConnection(
    userId: string,
    connection: ConnectionView,
    storage: FrockAiUserSettingsTransaction,
  ): Promise<ConnectionView>;
  replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    connection: ConnectionView,
    storage: FrockAiUserSettingsTransaction,
  ): Promise<ConnectionView>;
  getConnection(
    userId: string,
    connectionId: string,
    storage: FrockAiUserSettingsTransaction,
  ): Promise<ConnectionView | undefined>;
  registerConfigurationReadBootstrap(
    bootstrap: UserConfigurationReadBootstrap,
  ): () => void;
}

interface FrockAiUserBackendHost {
  storage: FrockAiUserSettingsStorage;
  settings: FrockAiUserSettingsHost;
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
    throw new Error("Stored Frock AI bootstrap marker is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    !value.userId
  ) {
    throw new Error("Stored Frock AI bootstrap marker is invalid");
  }
  return { schemaVersion: 1, userId: value.userId };
}

function decodeStoredCommand(input: unknown): StoredCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Frock AI command is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.accountId !== "string" ||
    !value.accountId
  ) {
    throw new Error("Stored Frock AI command is invalid");
  }
  return {
    accountId: value.accountId,
    command: decodeConnectionCommandV1(value.command),
    receipt: decodeConnectionCommandReceiptV1(value.receipt),
  };
}

function ambientConnection(): ConnectionView {
  return {
    connectionId: FROCK_AI_CONNECTION_ID,
    packageId: FROCK_AI_PACKAGE_ID,
    connectionTypeId: FROCK_AI_CONNECTION_TYPE_ID,
    displayName: "Frock AI",
    state: "ready",
    generation: FROCK_AI_CONNECTION_GENERATION,
    providerType: FROCK_AI_PROVIDER_TYPE,
    authorization: {
      schemaVersion: 1,
      kind: "ambient-native",
      credential: {
        schemaVersion: 1,
        configured: true,
        source: "ambient-native",
        writable: false,
        generation: FROCK_AI_CONNECTION_GENERATION,
      },
    },
    modelCatalog: frockAiStaticCatalogV1(),
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

function frockConnectionNeedsRepair(connection: ConnectionView): boolean {
  return (
    connection.state !== "ready" ||
    connection.providerType !== FROCK_AI_PROVIDER_TYPE ||
    !connection.modelCatalog?.models.some(
      (candidate) => candidate.providerModelId === FROCK_AI_DEFAULT_MODEL,
    )
  );
}

function requireApplied(receipt: OperationReceiptV1): void {
  if (receipt.status === "rejected") {
    throw new Error(receipt.failure);
  }
}

export class FrockAiUserBackendContribution implements UserConfigurationReadBootstrap {
  readonly packageId = FROCK_AI_PACKAGE_ID;

  constructor(private readonly host: FrockAiUserBackendHost) {}

  async bootstrap(userId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const marker = await storage.get<unknown>(BOOTSTRAP_KEY);
      if (marker !== undefined) {
        const decoded = decodeBootstrap(marker);
        if (decoded.userId !== userId) {
          throw new Error("Frock AI bootstrap belongs to another User");
        }
      }

      let settings = await this.host.settings.read(userId, storage);
      const installation = settings.packages.find(
        (candidate) => candidate.packageId === FROCK_AI_PACKAGE_ID,
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
              packageId: FROCK_AI_PACKAGE_ID,
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
        connection.packageId !== FROCK_AI_PACKAGE_ID ||
        connection.connectionTypeId !== FROCK_AI_CONNECTION_TYPE_ID
      ) {
        throw new Error("Frock AI Connection identity is invalid");
      }
      if (frockConnectionNeedsRepair(connection)) {
        await this.host.settings.replaceConnection(
          userId,
          FROCK_AI_CONNECTION_ID,
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
                connectionId: FROCK_AI_CONNECTION_ID,
                providerModelId: FROCK_AI_DEFAULT_MODEL,
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
          throw new Error("Frock AI command id collision");
        }
        return decoded.receipt;
      }
      const connectionId =
        "connectionId" in command
          ? command.connectionId
          : FROCK_AI_CONNECTION_ID;
      let status: ConnectionCommandReceiptV1["status"] = "failed";
      const current = await this.host.settings.getConnection(
        accountId,
        connectionId,
        storage,
      );
      if (current?.packageId === FROCK_AI_PACKAGE_ID) {
        if (command.type === "connection/refresh-models") {
          await this.host.settings.replaceConnection(
            accountId,
            connectionId,
            current.generation,
            { ...current, modelCatalog: frockAiStaticCatalogV1() },
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
    throw new Error("Frock AI uses its deployment binding, not a credential");
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }
}

export function createFrockAiUserBackendContribution(
  host: FrockAiUserBackendHost,
): FrockAiUserBackendContribution {
  return new FrockAiUserBackendContribution(host);
}

export function createFrockAiUserBackendPlugin(
  host: FrockAiUserBackendHost,
  lifecycle: { mount(value: FrockAiUserBackendContribution): () => void },
): Plugin {
  return () => {
    const contribution = createFrockAiUserBackendContribution(host);
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
 * What an application hands this Contribution: the ambient Frock AI Connection, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface FrockAiUserApplicationHostV1 {
  frockAi: FrockAiUserBackendHost;
}

/**
 * The manifest's `user` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const userContribution = defineUserBackendContribution<
  FrockAiUserApplicationHostV1,
  FrockAiUserBackendContribution
>({
  specifier: "@frockbot/plugin-provider-frock-ai/user",
  create: (host, lifecycle) =>
    createFrockAiUserBackendPlugin(host.frockAi, lifecycle),
});
