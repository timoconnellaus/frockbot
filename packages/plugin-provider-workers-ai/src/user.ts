import type { ConnectionView } from "@frockbot/configuration-core";
import {
  decodeConnectionCommandReceiptV1,
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/connection-core";
import type {
  UserConfigurationReadBootstrap,
  UserSettingsBackendContribution,
  UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  WORKERS_AI_CONNECTION_GENERATION,
  WORKERS_AI_CONNECTION_ID,
  WORKERS_AI_CONNECTION_TYPE_ID,
  WORKERS_AI_DEFAULT_MODEL,
  WORKERS_AI_PACKAGE_ID,
  WORKERS_AI_PROVIDER_TYPE,
  workersAiStaticCatalogV1,
} from "./catalog.js";

const BOOTSTRAP_KEY = "provider-workers-ai:bootstrap-v1";
const COMMAND_PREFIX = "provider-workers-ai:command:";
const PACKAGE_VERSION = "0.0.1";

interface WorkersAiUserBackendHost {
  storage: UserSettingsStorage;
  settings: UserSettingsBackendContribution;
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
    throw new Error("Stored Workers AI bootstrap marker is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    !value.userId
  ) {
    throw new Error("Stored Workers AI bootstrap marker is invalid");
  }
  return { schemaVersion: 1, userId: value.userId };
}

function decodeStoredCommand(input: unknown): StoredCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Workers AI command is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.accountId !== "string" ||
    !value.accountId
  ) {
    throw new Error("Stored Workers AI command is invalid");
  }
  return {
    accountId: value.accountId,
    command: decodeConnectionCommandV1(value.command),
    receipt: decodeConnectionCommandReceiptV1(value.receipt),
  };
}

function ambientConnection(): ConnectionView {
  return {
    connectionId: WORKERS_AI_CONNECTION_ID,
    packageId: WORKERS_AI_PACKAGE_ID,
    connectionTypeId: WORKERS_AI_CONNECTION_TYPE_ID,
    displayName: "Cloudflare Workers AI",
    state: "ready",
    generation: WORKERS_AI_CONNECTION_GENERATION,
    providerType: WORKERS_AI_PROVIDER_TYPE,
    authorization: {
      schemaVersion: 1,
      kind: "ambient-native",
      credential: {
        schemaVersion: 1,
        configured: true,
        source: "ambient-native",
        writable: false,
        generation: WORKERS_AI_CONNECTION_GENERATION,
      },
    },
    modelCatalog: workersAiStaticCatalogV1(),
    safeMetadata: { catalog: "static" },
  };
}

export class WorkersAiUserBackendContribution implements UserConfigurationReadBootstrap {
  readonly packageId = WORKERS_AI_PACKAGE_ID;

  constructor(private readonly host: WorkersAiUserBackendHost) {}

  async bootstrap(userId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const marker = await storage.get<unknown>(BOOTSTRAP_KEY);
      if (marker !== undefined) {
        const decoded = decodeBootstrap(marker);
        if (decoded.userId !== userId) {
          throw new Error("Workers AI bootstrap belongs to another User");
        }
        return;
      }

      let settings = await this.host.settings.read(userId, storage);
      if (
        !settings.packages.some(
          (installation) => installation.packageId === WORKERS_AI_PACKAGE_ID,
        )
      ) {
        await this.host.settings.executeConfigurationCommand(
          userId,
          {
            schemaVersion: 1,
            type: "user/install-package",
            commandId: "workers-ai-bootstrap-install",
            expectedRevision: settings.revision,
            packageId: WORKERS_AI_PACKAGE_ID,
            version: PACKAGE_VERSION,
          },
          storage,
        );
      }

      const connection = await this.host.settings.createConnection(
        userId,
        ambientConnection(),
        storage,
      );
      if (
        connection.packageId !== WORKERS_AI_PACKAGE_ID ||
        connection.connectionTypeId !== WORKERS_AI_CONNECTION_TYPE_ID
      ) {
        throw new Error("Workers AI Connection identity is invalid");
      }

      settings = await this.host.settings.read(userId, storage);
      if (
        settings.newBotModelTemplate === undefined &&
        settings.newBotModelTemplateSource !== "user"
      ) {
        await this.host.settings.executeConfigurationCommand(
          userId,
          {
            schemaVersion: 1,
            type: "user/set-new-bot-model",
            commandId: "workers-ai-bootstrap-default",
            expectedRevision: settings.revision,
            model: {
              connectionId: WORKERS_AI_CONNECTION_ID,
              providerModelId: WORKERS_AI_DEFAULT_MODEL,
            },
            source: "auto",
          },
          storage,
        );
      }
      await storage.put(BOOTSTRAP_KEY, { schemaVersion: 1, userId });
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
          throw new Error("Workers AI command id collision");
        }
        return decoded.receipt;
      }
      const connectionId =
        "connectionId" in command
          ? command.connectionId
          : WORKERS_AI_CONNECTION_ID;
      let status: ConnectionCommandReceiptV1["status"] = "failed";
      const current = await this.host.settings.getConnection(
        accountId,
        connectionId,
        storage,
      );
      if (current?.packageId === WORKERS_AI_PACKAGE_ID) {
        if (command.type === "connection/refresh-models") {
          await this.host.settings.replaceConnection(
            accountId,
            connectionId,
            current.generation,
            { ...current, modelCatalog: workersAiStaticCatalogV1() },
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
    throw new Error("Workers AI uses its deployment binding, not a credential");
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }
}

export function createWorkersAiUserBackendContribution(
  host: WorkersAiUserBackendHost,
): WorkersAiUserBackendContribution {
  return new WorkersAiUserBackendContribution(host);
}

export function createWorkersAiUserBackendPlugin(
  host: WorkersAiUserBackendHost,
  lifecycle: { mount(value: WorkersAiUserBackendContribution): () => void },
): Plugin {
  return () => {
    const contribution = createWorkersAiUserBackendContribution(host);
    const unregister =
      host.settings.registerConfigurationReadBootstrap(contribution);
    const dispose = lifecycle.mount(contribution);
    return () => {
      unregister();
      dispose();
    };
  };
}
