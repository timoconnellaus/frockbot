import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type ConnectionModelCatalogV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import type { ConnectionView } from "@frockbot/configuration-core";
import type {
  CredentialStorage,
  CredentialTransaction,
  CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import { OllamaCloudClient } from "./client.js";
import { OLLAMA_CLOUD_PROVIDER } from "./runtime.js";

const PACKAGE_ID = "provider-ollama-cloud";
const CONNECTION_TYPE_ID = "ollama-cloud-account";
const COMMAND_PREFIX = "ollama-connection-command:";
const PENDING_KEY = "ollama-pending-connection-commands";
const ACCOUNT_KEY = "ollama-connection-account";
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const RECOVERY_DELAY_MS = 60_000;
const MODEL_LEASE_MS = 30 * 60 * 1_000;

interface StoredCommand {
  schemaVersion: 1;
  commandId: string;
  fingerprint: string;
  accountId: string;
  connectionId: string;
  credentialGeneration?: string;
  expectedGeneration?: string;
  operation: ConnectionCommandV1["type"];
  label?: string;
  enabled?: boolean;
  revokeUpstream?: boolean;
  receipt?: ConnectionCommandReceiptV1;
}

type OllamaCredentialContribution = Omit<
  CredentialUserBackendContribution,
  "lease"
> & {
  lease(
    input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      effectId: string;
      expiresAt: string;
      expectedGeneration?: string;
    },
    storage?: CredentialTransaction,
  ): Promise<CredentialLeaseV1>;
};

export interface OllamaUserBackendHost {
  storage: UserSettingsStorage &
    CredentialStorage & {
      getAlarm?(): Promise<number | null>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
    };
  settings: UserSettingsBackendContribution;
  credentials: OllamaCredentialContribution;
  client?: OllamaCloudClient;
  now?: () => number;
  randomId?: () => string;
}

function commandKey(commandId: string): string {
  return `${COMMAND_PREFIX}${commandId}`;
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function receipt(
  record: StoredCommand,
  status: ConnectionCommandReceiptV1["status"],
): ConnectionCommandReceiptV1 {
  return {
    schemaVersion: 1,
    commandId: record.commandId,
    connectionId: record.connectionId,
    status,
  };
}

export class OllamaCloudUserBackendContribution {
  readonly packageId = PACKAGE_ID;
  private readonly client: OllamaCloudClient;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly host: OllamaUserBackendHost) {
    this.client = host.client ?? new OllamaCloudClient();
    this.now = host.now ?? Date.now;
    this.randomId = host.randomId ?? crypto.randomUUID.bind(crypto);
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const storedAccount = await this.host.storage.get<string>(ACCOUNT_KEY);
    if (storedAccount && storedAccount !== accountId) {
      throw new Error("Ollama Connection authority does not match");
    }
    if (!storedAccount) await this.host.storage.put(ACCOUNT_KEY, accountId);
    const commandFingerprint = await fingerprint(command);
    const existing = await this.host.storage.get<StoredCommand>(
      commandKey(command.commandId),
    );
    if (existing) {
      if (
        existing.accountId !== accountId ||
        existing.fingerprint !== commandFingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      if (existing.receipt) return existing.receipt;
      await this.ensureAdmittedState(
        existing,
        command.type === "connection/create-api-key" ||
          command.type === "connection/rotate-api-key"
          ? command.apiKey
          : undefined,
      );
      return this.resume(existing);
    }

    const record = await this.admit(accountId, command, commandFingerprint);
    return this.resume(record);
  }

  private async admit(
    accountId: string,
    command: ConnectionCommandV1,
    commandFingerprint: string,
  ): Promise<StoredCommand> {
    if (command.type === "connection/create-api-key") {
      if (
        command.packageId !== PACKAGE_ID ||
        command.connectionTypeId !== CONNECTION_TYPE_ID
      ) {
        throw new Error("Ollama Cloud Connection type is invalid");
      }
      if (
        !(await this.host.settings.isPackageInstalled(accountId, PACKAGE_ID))
      ) {
        throw new Error("Ollama Cloud Package is not installed and enabled");
      }
      const connectionId = `connection-${this.randomId()}`;
      const generation = this.randomId();
      const record: StoredCommand = {
        schemaVersion: 1,
        commandId: command.commandId,
        fingerprint: commandFingerprint,
        accountId,
        connectionId,
        credentialGeneration: generation,
        operation: command.type,
        label: command.label,
      };
      const prepared = await this.host.credentials.prepareApiKey({
        accountId,
        connectionId,
        packageId: PACKAGE_ID,
        generation,
        apiKey: command.apiKey,
      });
      await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const settings = await this.host.settings.readSnapshot(storage);
          if (
            !settings.packages.some(
              (pkg) =>
                pkg.packageId === PACKAGE_ID && pkg.state === "installed",
            )
          ) {
            throw new Error(
              "Ollama Cloud Package is not installed and enabled",
            );
          }
          await this.host.settings.createConnection(
            accountId,
            this.authorizingConnection(record, command.label),
            storage,
          );
          await this.host.credentials.stagePreparedApiKey(prepared, storage);
          await this.admitRecord(record, storage);
        },
      );
      await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      return record;
    }

    const connection = await this.requireConnection(
      accountId,
      command.connectionId,
    );
    if (command.type === "connection/rotate-api-key") {
      if (connection.state !== "ready" && connection.state !== "disabled") {
        throw new Error(`Connection is ${connection.state}`);
      }
      const generation = this.randomId();
      const record: StoredCommand = {
        schemaVersion: 1,
        commandId: command.commandId,
        fingerprint: commandFingerprint,
        accountId,
        connectionId: connection.connectionId,
        credentialGeneration: generation,
        expectedGeneration: connection.generation,
        operation: command.type,
      };
      const prepared = await this.host.credentials.prepareApiKey({
        accountId,
        connectionId: connection.connectionId,
        packageId: PACKAGE_ID,
        generation,
        apiKey: command.apiKey,
      });
      await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const current = await this.host.settings.getConnection(
            accountId,
            connection.connectionId,
            storage,
          );
          if (
            !current ||
            current.generation !== connection.generation ||
            (current.state !== "ready" && current.state !== "disabled")
          ) {
            throw new Error("Connection changed before credential rotation");
          }
          await this.host.credentials.stagePreparedApiKey(prepared, storage);
          await this.admitRecord(record, storage);
        },
      );
      await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      return record;
    }

    const record: StoredCommand = {
      schemaVersion: 1,
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      accountId,
      connectionId: connection.connectionId,
      expectedGeneration: connection.generation,
      operation: command.type,
      ...(command.type === "connection/update-label"
        ? { label: command.label }
        : {}),
      ...(command.type === "connection/set-enabled"
        ? { enabled: command.enabled }
        : {}),
      ...(command.type === "connection/disconnect"
        ? { revokeUpstream: command.revokeUpstream }
        : {}),
    };
    await this.admitRecord(record);
    await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
    return record;
  }

  private async ensureAdmittedState(
    record: StoredCommand,
    apiKey?: string,
  ): Promise<void> {
    if (record.operation === "connection/create-api-key") {
      const current = await this.host.settings.getConnection(
        record.accountId,
        record.connectionId,
      );
      if (!current) {
        await this.host.settings.createConnection(
          record.accountId,
          this.authorizingConnection(record, record.label ?? "Ollama Cloud"),
        );
      }
    }
    if (apiKey && record.credentialGeneration) {
      await this.host.credentials.stageApiKey({
        accountId: record.accountId,
        connectionId: record.connectionId,
        packageId: PACKAGE_ID,
        generation: record.credentialGeneration,
        apiKey,
      });
    }
  }

  private async admitRecord(
    record: StoredCommand,
    storage?: CredentialTransaction,
  ): Promise<void> {
    const admit = async (transaction: CredentialTransaction) => {
      const existing = await transaction.get<StoredCommand>(
        commandKey(record.commandId),
      );
      if (existing) {
        if (
          existing.accountId !== record.accountId ||
          existing.fingerprint !== record.fingerprint
        ) {
          throw new Error("Connection command idempotency key was reused");
        }
        return;
      }
      const pending =
        (await transaction.get<string[]>(PENDING_KEY))?.filter(
          (id) => id !== record.commandId,
        ) ?? [];
      await transaction.put({
        [commandKey(record.commandId)]: record,
        [PENDING_KEY]: [...pending, record.commandId],
      });
      await transaction.setAlarm?.(this.now() + RECOVERY_DELAY_MS);
    };
    await (storage ? admit(storage) : this.host.storage.transaction(admit));
  }

  private authorizingConnection(
    record: StoredCommand,
    displayName: string,
  ): ConnectionView {
    const updatedAt = new Date(this.now()).toISOString();
    return {
      connectionId: record.connectionId,
      packageId: PACKAGE_ID,
      connectionTypeId: CONNECTION_TYPE_ID,
      displayName,
      state: "authorizing",
      generation: record.credentialGeneration,
      providerType: OLLAMA_CLOUD_PROVIDER,
      authorization: {
        schemaVersion: 1,
        kind: "api-key",
        credential: {
          schemaVersion: 1,
          configured: true,
          source: "api-key",
          writable: true,
          generation: record.credentialGeneration,
          updatedAt,
        },
      },
      settings: {},
      safeMetadata: {},
    };
  }

  private async resume(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (record.operation) {
      case "connection/create-api-key":
      case "connection/rotate-api-key":
        return this.validateAndActivate(record);
      case "connection/update-label":
        return this.updateLabel(record);
      case "connection/refresh-models":
        return this.refreshCatalog(record);
      case "connection/set-enabled":
        return this.setEnabled(record);
      case "connection/disconnect":
        return this.disconnect(record);
    }
  }

  private catalog(
    models: ConnectionModelCatalogV1["models"],
  ): ConnectionModelCatalogV1 {
    const now = this.now();
    return {
      schemaVersion: 1,
      generation: this.randomId(),
      state: "fresh",
      models,
      refreshedAt: new Date(now).toISOString(),
      refreshAfter: new Date(now + REFRESH_INTERVAL_MS).toISOString(),
    };
  }

  private async validateAndActivate(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const generation = record.credentialGeneration;
    if (!generation) throw new Error("Credential generation is unavailable");
    const projected = await this.requireConnection(
      record.accountId,
      record.connectionId,
    );
    if (
      projected.generation === generation &&
      (projected.state === "ready" || projected.state === "disabled")
    ) {
      return this.finishRecord(record, "applied");
    }
    try {
      const apiKey = await this.host.credentials.readStagedApiKey({
        accountId: record.accountId,
        connectionId: record.connectionId,
        packageId: PACKAGE_ID,
        generation,
      });
      const models = await this.client.listModels(apiKey);
      await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const current = await this.host.settings.getConnection(
            record.accountId,
            record.connectionId,
            storage,
          );
          if (!current || current.packageId !== PACKAGE_ID) {
            throw new Error("Ollama Cloud Connection is unavailable");
          }
          if (
            record.operation === "connection/create-api-key" &&
            (current.state !== "authorizing" ||
              current.generation !== generation)
          ) {
            throw new Error(`Connection is ${current.state}`);
          }
          if (
            record.operation === "connection/rotate-api-key" &&
            current.state !== "ready" &&
            current.state !== "disabled"
          ) {
            throw new Error(`Connection is ${current.state}`);
          }
          await this.host.credentials.activate(
            {
              accountId: record.accountId,
              connectionId: record.connectionId,
              packageId: PACKAGE_ID,
              generation,
            },
            storage,
          );
          await this.host.settings.replaceConnection(
            record.accountId,
            record.connectionId,
            record.expectedGeneration ?? current.generation,
            {
              ...current,
              state: current.state === "disabled" ? "disabled" : "ready",
              generation,
              modelCatalog: this.catalog(models),
              authorization: {
                schemaVersion: 1,
                kind: "api-key",
                credential: {
                  schemaVersion: 1,
                  configured: true,
                  source: "api-key",
                  writable: true,
                  generation,
                  updatedAt: new Date(this.now()).toISOString(),
                },
              },
              failure: undefined,
            },
            storage,
          );
        },
      );
      return this.finishRecord(record, "applied");
    } catch (error) {
      await this.host.credentials.discardPending(
        record.connectionId,
        generation,
      );
      if (record.operation === "connection/create-api-key") {
        const current = await this.requireConnection(
          record.accountId,
          record.connectionId,
        );
        if (
          current.state === "authorizing" &&
          current.generation === generation
        ) {
          await this.host.settings.replaceConnection(
            record.accountId,
            record.connectionId,
            current.generation,
            {
              ...current,
              state: "failed",
              authorization: {
                schemaVersion: 1,
                kind: "api-key",
                credential: {
                  schemaVersion: 1,
                  configured: false,
                  source: "api-key",
                  writable: true,
                },
              },
              failure:
                error instanceof Error
                  ? error.message
                  : "Ollama Cloud validation failed",
            },
          );
        }
      }
      return this.finishRecord(record, "failed");
    }
  }

  private async updateLabel(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const current = await this.requireConnection(
      record.accountId,
      record.connectionId,
    );
    if (!record.label) return this.finishRecord(record, "failed");
    await this.host.settings.replaceConnection(
      record.accountId,
      record.connectionId,
      current.generation,
      { ...current, displayName: record.label },
    );
    return this.finishRecord(record, "applied");
  }

  private async refreshCatalog(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const effectId = `catalog:${record.commandId}`;
    let lease: CredentialLeaseV1 | undefined;
    try {
      lease = await this.host.credentials.lease({
        accountId: record.accountId,
        connectionId: record.connectionId,
        packageId: PACKAGE_ID,
        effectId,
        expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
      });
      const apiKey = await this.host.credentials.openLease({
        accountId: record.accountId,
        packageId: PACKAGE_ID,
        lease,
      });
      const models = await this.client.listModels(apiKey);
      const current = await this.requireConnection(
        record.accountId,
        record.connectionId,
      );
      await this.host.settings.replaceConnection(
        record.accountId,
        record.connectionId,
        current.generation,
        { ...current, modelCatalog: this.catalog(models), failure: undefined },
      );
      return this.finishRecord(record, "applied");
    } catch (error) {
      const current = await this.requireConnection(
        record.accountId,
        record.connectionId,
      );
      if (current.modelCatalog) {
        await this.host.settings.replaceConnection(
          record.accountId,
          record.connectionId,
          current.generation,
          {
            ...current,
            modelCatalog: {
              ...current.modelCatalog,
              state: "stale",
              refreshAfter: new Date(
                this.now() + REFRESH_INTERVAL_MS,
              ).toISOString(),
              failure:
                error instanceof Error
                  ? error.message
                  : "Ollama Cloud catalog refresh failed",
            },
          },
        );
      }
      return this.finishRecord(record, "failed");
    } finally {
      if (lease) await this.host.credentials.settle(effectId);
    }
  }

  private async setEnabled(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const current = await this.requireConnection(
      record.accountId,
      record.connectionId,
    );
    if (current.state !== "ready" && current.state !== "disabled") {
      return this.finishRecord(record, "failed");
    }
    await this.host.settings.replaceConnection(
      record.accountId,
      record.connectionId,
      current.generation,
      { ...current, state: record.enabled ? "ready" : "disabled" },
    );
    return this.finishRecord(record, "applied");
  }

  private async disconnect(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const expectedGeneration = record.expectedGeneration;
    if (!expectedGeneration) return this.finishRecord(record, "failed");
    const transition = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const current = await this.host.settings.getConnection(
          record.accountId,
          record.connectionId,
          storage,
        );
        if (!current || current.packageId !== PACKAGE_ID) return "stale";
        if (current.generation !== expectedGeneration) return "stale";
        if (current.state === "revoked") return "revoked";
        if (current.state === "reconciliation-required") {
          return "reconciliation-required";
        }
        if (current.state !== "revoking") {
          await this.host.settings.replaceConnection(
            record.accountId,
            record.connectionId,
            expectedGeneration,
            { ...current, state: "revoking" },
            storage,
          );
        }
        return "revoking";
      },
    );
    if (transition === "stale") return this.finishRecord(record, "failed");
    if (transition === "revoked") return this.finishRecord(record, "applied");
    if (transition === "reconciliation-required") {
      return this.finishRecord(record, "reconciliation-required");
    }

    await this.host.credentials.disconnect(record.connectionId);
    const revoking = await this.requireConnection(
      record.accountId,
      record.connectionId,
    );
    if (revoking.generation !== expectedGeneration) {
      return this.finishRecord(record, "failed");
    }
    const unsupportedUpstreamRevoke = record.revokeUpstream === true;
    await this.host.settings.replaceConnection(
      record.accountId,
      record.connectionId,
      expectedGeneration,
      {
        ...revoking,
        state: unsupportedUpstreamRevoke
          ? "reconciliation-required"
          : "revoked",
        ...(unsupportedUpstreamRevoke
          ? {
              failure:
                "Ollama Cloud does not expose upstream API-key revocation",
            }
          : {}),
      },
    );
    return this.finishRecord(
      record,
      unsupportedUpstreamRevoke ? "reconciliation-required" : "applied",
    );
  }

  private async finishRecord(
    record: StoredCommand,
    status: ConnectionCommandReceiptV1["status"],
  ): Promise<ConnectionCommandReceiptV1> {
    const result = receipt(record, status);
    await this.host.storage.transaction(async (storage) => {
      const pending =
        (await storage.get<string[]>(PENDING_KEY))?.filter(
          (id) => id !== record.commandId,
        ) ?? [];
      await storage.put({
        [commandKey(record.commandId)]: { ...record, receipt: result },
        [PENDING_KEY]: pending,
      });
    });
    await this.scheduleNextAlarm(record.accountId);
    return result;
  }

  private async scheduleNextAlarm(accountId: string): Promise<void> {
    const pending = (await this.host.storage.get<string[]>(PENDING_KEY)) ?? [];
    const settings = await this.host.settings.read(accountId);
    const catalogDeadlines = settings.connections.flatMap((connection) => {
      const refreshAfter = connection.modelCatalog?.refreshAfter;
      if (
        connection.packageId !== PACKAGE_ID ||
        connection.state !== "ready" ||
        !refreshAfter
      ) {
        return [];
      }
      const deadline = Date.parse(refreshAfter);
      return Number.isFinite(deadline) ? [deadline] : [];
    });
    const credentialExpiry = await this.host.credentials.nextLeaseExpiry();
    const deadlines = [
      ...(pending.length > 0 ? [this.now() + RECOVERY_DELAY_MS] : []),
      ...catalogDeadlines,
      ...(credentialExpiry === undefined ? [] : [credentialExpiry]),
    ];
    if (deadlines.length > 0) {
      await this.host.storage.setAlarm(Math.min(...deadlines));
    }
  }

  async leaseModelCredential(input: {
    accountId: string;
    connectionId: string;
    providerModelId: string;
    effectId: string;
  }): Promise<CredentialLeaseV1> {
    const connection = await this.requireConnection(
      input.accountId,
      input.connectionId,
    );
    if (connection.state !== "ready" || !connection.generation) {
      throw new Error(`Connection is ${connection.state}`);
    }
    const admittedGeneration = connection.generation;
    const known = connection.modelCatalog?.models.some(
      (model) => model.providerModelId === input.providerModelId,
    );
    let resolvedModel: ConnectionModelCatalogV1["models"][number] | undefined;
    if (!known) {
      const discoveryEffectId = `resolve:${input.effectId}`;
      const discoveryLease = await this.host.credentials.lease({
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: PACKAGE_ID,
        effectId: discoveryEffectId,
        expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
        expectedGeneration: admittedGeneration,
      });
      try {
        const apiKey = await this.host.credentials.openLease({
          accountId: input.accountId,
          packageId: PACKAGE_ID,
          lease: discoveryLease,
        });
        resolvedModel = await this.client.resolveModel(
          apiKey,
          input.providerModelId,
        );
      } finally {
        await this.host.credentials.settle(discoveryEffectId);
      }
    }

    await this.host.credentials.expireLeases();
    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const current = await this.host.settings.getConnection(
          input.accountId,
          input.connectionId,
          storage,
        );
        if (
          !current ||
          current.packageId !== PACKAGE_ID ||
          current.state !== "ready" ||
          current.generation !== admittedGeneration
        ) {
          throw new Error("Connection changed before model authorization");
        }
        if (
          resolvedModel &&
          !current.modelCatalog?.models.some(
            (model) => model.providerModelId === input.providerModelId,
          )
        ) {
          const catalog = current.modelCatalog ?? this.catalog([]);
          await this.host.settings.replaceConnection(
            input.accountId,
            input.connectionId,
            admittedGeneration,
            {
              ...current,
              modelCatalog: {
                ...catalog,
                generation: this.randomId(),
                models: [...catalog.models, resolvedModel],
              },
            },
            storage,
          );
        }
        return this.host.credentials.lease(
          {
            accountId: input.accountId,
            connectionId: input.connectionId,
            packageId: PACKAGE_ID,
            effectId: input.effectId,
            expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
            expectedGeneration: admittedGeneration,
          },
          storage,
        );
      },
    );
  }

  async settleModelCredential(effectId: string): Promise<void> {
    await this.host.credentials.settle(effectId);
  }

  async alarm(): Promise<void> {
    const pending = (await this.host.storage.get<string[]>(PENDING_KEY)) ?? [];
    for (const commandId of pending) {
      const record = await this.host.storage.get<StoredCommand>(
        commandKey(commandId),
      );
      if (record && !record.receipt) {
        await this.ensureAdmittedState(record);
        await this.resume(record);
      }
    }
    const accountId = await this.host.storage.get<string>(ACCOUNT_KEY);
    if (!accountId) return;
    const settings = await this.host.settings.read(accountId);
    for (const connection of settings.connections) {
      const refreshAfter = connection.modelCatalog?.refreshAfter;
      if (
        connection.packageId === PACKAGE_ID &&
        connection.state === "ready" &&
        refreshAfter &&
        Date.parse(refreshAfter) <= this.now()
      ) {
        await this.executeConnection(accountId, {
          schemaVersion: 1,
          type: "connection/refresh-models",
          commandId: `refresh-${connection.connectionId}-${Date.parse(refreshAfter)}`,
          connectionId: connection.connectionId,
        });
      }
    }
    await this.scheduleNextAlarm(accountId);
  }

  private async requireConnection(
    accountId: string,
    connectionId: string,
  ): Promise<ConnectionView> {
    const connection = await this.host.settings.getConnection(
      accountId,
      connectionId,
    );
    if (!connection || connection.packageId !== PACKAGE_ID) {
      throw new Error("Ollama Cloud Connection is unavailable");
    }
    return connection;
  }
}

export function createOllamaCloudUserBackendContribution(
  host: OllamaUserBackendHost,
): OllamaCloudUserBackendContribution {
  return new OllamaCloudUserBackendContribution(host);
}

export function createOllamaCloudUserBackendPlugin(
  host: OllamaUserBackendHost,
  lifecycle: { mount(value: OllamaCloudUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createOllamaCloudUserBackendContribution(host));
}
