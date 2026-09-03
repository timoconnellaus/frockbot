import {
  MAX_CONNECTION_SETTINGS_V1,
  decodeConnectionCommandReceiptV1,
  decodeConnectionCommandV1,
  decodeConnectionModelCatalogV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type ConnectionModelCatalogV1,
  type ConnectionModelV1,
  type ConnectionSettingsV1,
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
import {
  decodeOllamaApiBaseUrl,
  OllamaCloudClient,
  type OllamaCloudClientConfig,
} from "./client.js";
import { OLLAMA_CLOUD_PROVIDER } from "./runtime.js";
import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";

const PACKAGE_ID = "provider-ollama-cloud";
const CONNECTION_TYPE_ID = "ollama-cloud-account";
const COMMAND_PREFIX = "ollama-connection-command:";
const PENDING_KEY = "ollama-pending-connection-commands";
const RECEIPT_INDEX_KEY = "ollama-connection-receipt-index";
const COMMAND_TOMBSTONES_KEY = "ollama-connection-command-tombstones";
const MAX_MANUAL_RECEIPTS = 256;
const MAX_COMMAND_TOMBSTONES = 128;
const MAX_MANUAL_COMMANDS = MAX_MANUAL_RECEIPTS + MAX_COMMAND_TOMBSTONES;
const MAX_PENDING_COMMANDS = 64;
const MAX_PENDING_RECOVERIES_PER_ALARM = 1;
/**
 * How many alarm-driven attempts a pending Connection command gets before it is
 * abandoned. Without a cap an endpoint that accepts the connection and never
 * answers is re-driven once a minute forever and its Connection sits in
 * `authorizing` with nothing to show the User.
 */
const MAX_PENDING_RECOVERY_ATTEMPTS = 3;
const MAX_CATALOG_REFRESHES_PER_ALARM = 1;
const ACCOUNT_KEY = "ollama-connection-account";
const AUTOMATIC_REFRESH_RECEIPT_PREFIX = "ollama-refresh-receipt:";

const MUTATION_SEQUENCE_PREFIX = "ollama-mutation-sequence:";
const MODEL_RESOLUTION_PREFIX = "ollama-model-resolution:";
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const RECOVERY_DELAY_MS = 60_000;
const MODEL_LEASE_MS = 30 * 60 * 1_000;
const MAX_CONNECTION_MODELS = 100;
const MAX_DISCOVERED_MODELS = 90;

interface StoredCommand {
  schemaVersion: 1;
  commandId: string;
  fingerprint: string;
  accountId: string;
  connectionId: string;
  credentialGeneration?: string;
  expectedGeneration?: string;
  /**
   * `connection/create` is not among them: an Ollama Cloud account is always
   * a keyed Connection, so the keyless create command is refused on arrival
   * and never reaches a durable record.
   */
  operation: Exclude<ConnectionCommandV1["type"], "connection/create">;
  label?: string;
  settings?: Record<string, string>;
  enabled?: boolean;
  revokeUpstream?: boolean;
  receipt?: ConnectionCommandReceiptV1;
  completedAt?: number;
  automaticRefresh?: boolean;
  mutationSequence?: number;
  settlementEffectId?: string;
  settlementStatus?: "applied" | "failed";
  validationCatalog?: ConnectionModelCatalogV1;
  validationFailure?: string;
  validationStatus?: "applied" | "failed";
  providerRetryPolicy?: "safe-metadata-read";
  /** Alarm-driven resume attempts so far; capped, so a command always settles. */
  recoveryAttempts?: number;
}

interface StoredModelResolution {
  schemaVersion: 1;
  effectId: string;
  accountId: string;
  connectionId: string;
  connectionGeneration: string;
  providerModelId: string;
  retryPolicy: "safe-metadata-read";
  status: "pending" | "applied" | "failed";
  model?: ConnectionModelCatalogV1["models"][number];
  failure?: string;
}

type StoredCommandTombstone = StoredCommand & {
  receipt: ConnectionCommandReceiptV1;
  completedAt: number;
};

type OllamaCredentialContribution = Omit<
  CredentialUserBackendContribution,
  "discardPending" | "lease" | "replayLease" | "settle"
> & {
  discardPending(
    connectionId: string,
    generation: string,
    storage?: CredentialTransaction,
  ): Promise<void>;
  replayLease(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<CredentialLeaseV1 | undefined>;
  lease(
    input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      effectId: string;
      expiresAt: string;
      expectedGeneration: string;
      credentialState?: "active" | "pending";
    },
    storage?: CredentialTransaction,
  ): Promise<CredentialLeaseV1>;
  settle(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<void>;
};

// Ollama Cloud names its models bare (`gpt-oss:20b`, `glm-5.1`), with no
// `:cloud` suffix. `gpt-oss:20b` is the smallest model that is routinely
// present, so a probe against it costs the least; otherwise the first
// discovered model has to do.
const PREFERRED_PROBE_MODEL_ID = "gpt-oss:20b";

function probeModelId(models: readonly ConnectionModelV1[]): string {
  const preferred = models.find(
    (model) => model.providerModelId === PREFERRED_PROBE_MODEL_ID,
  );
  const chosen = preferred ?? models[0];
  if (!chosen) {
    throw new Error(
      "Ollama Cloud exposed no model to validate the key against",
    );
  }
  return chosen.providerModelId;
}

// The only setting this Package's Connection Type declares (manifest v4). The
// Connection settings bag carries it under the same id, which the shared
// decoder requires to be lower-case kebab.
const API_BASE_URL_SETTING = "api-base-url";

/** The per-value bound the shared Connection settings decoder enforces. */
const MAX_CONNECTION_SETTING_VALUE = 2_048;

/**
 * Decode the Connection settings a `connection/create-api-key` command carried.
 *
 * An unknown key or an unusable endpoint is a User-visible refusal, not a
 * silently ignored field.
 */
function decodeOllamaConnectionSettings(
  input: ConnectionSettingsV1 | undefined,
): Record<string, string> {
  if (input === undefined) return {};
  const entries = Object.entries(input);
  if (entries.length > MAX_CONNECTION_SETTINGS_V1) {
    throw new Error("Ollama Cloud Connection settings are too many");
  }
  const accepted: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key !== API_BASE_URL_SETTING) {
      throw new Error(
        `Ollama Cloud Connection setting "${key}" is not supported`,
      );
    }
    accepted[key] = decodeOllamaApiBaseUrl(value);
  }
  return accepted;
}

function decodeStoredConnectionSettings(
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Ollama Connection settings are invalid");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_CONNECTION_SETTINGS_V1) {
    throw new Error("Stored Ollama Connection settings are invalid");
  }
  const raw: Record<string, string> = {};
  for (const [key, value] of entries) {
    raw[key] = storedText(
      value,
      `settings.${key}`,
      MAX_CONNECTION_SETTING_VALUE,
    );
  }
  try {
    return decodeOllamaConnectionSettings(raw);
  } catch {
    throw new Error("Stored Ollama Connection settings are invalid");
  }
}

/** Read a Connection's endpoint root off its durable projection. */
function connectionApiBaseUrl(
  connection: ConnectionView | undefined,
): string | undefined {
  const candidate = connection?.settings?.[API_BASE_URL_SETTING];
  return candidate === undefined
    ? undefined
    : decodeOllamaApiBaseUrl(candidate);
}

export interface OllamaUserBackendHost {
  storage: UserSettingsStorage &
    CredentialStorage & {
      getAlarm?(): Promise<number | null>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
    };
  settings: UserSettingsBackendContribution;
  credentials: OllamaCredentialContribution;
  /** A client the host supplies for every Connection; wins when given. */
  client?: OllamaCloudClient;
  /** Build a client for one Connection's endpoint. */
  createClient?(config: OllamaCloudClientConfig): OllamaCloudClient;
  now?: () => number;
  randomId?: () => string;
}

function commandKey(commandId: string): string {
  return `${COMMAND_PREFIX}${commandId}`;
}

function modelResolutionKey(effectId: string): string {
  return `${MODEL_RESOLUTION_PREFIX}${effectId}`;
}

function mutationSequenceKey(
  connectionId: string,
  operation: StoredCommand["operation"],
): string {
  return `${MUTATION_SEQUENCE_PREFIX}${connectionId}:${operation}`;
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

function storedRecord(
  input: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} is invalid`);
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function storedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeStoredAccount(input: unknown): string {
  return storedText(input, "Stored Ollama account", 256);
}

function decodeCommandIdList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) {
    throw new Error(`Stored Ollama ${label} is invalid`);
  }
  return [
    ...new Set(input.map((value) => storedText(value, "commandId", 128))),
  ];
}

function decodePendingCommands(input: unknown): string[] {
  const pending = decodeCommandIdList(input, "pending commands");
  if (pending.length > MAX_PENDING_COMMANDS) {
    throw new Error("Stored Ollama pending commands are invalid");
  }
  return pending;
}

function decodeReceiptIndex(input: unknown): string[] {
  const index = decodeCommandIdList(input, "receipt index");
  if (index.length > MAX_MANUAL_RECEIPTS) {
    throw new Error("Stored Ollama receipt index is invalid");
  }
  return index;
}

function decodeCommandTombstones(input: unknown): StoredCommandTombstone[] {
  if (!Array.isArray(input) || input.length > MAX_COMMAND_TOMBSTONES) {
    throw new Error("Stored Ollama command tombstones are invalid");
  }
  return input.map((value) => {
    const command = decodeStoredCommand(value);
    if (!command.receipt || command.completedAt === undefined) {
      throw new Error("Stored Ollama command tombstone is invalid");
    }
    return command as StoredCommandTombstone;
  });
}

function decodeStoredCommand(input: unknown): StoredCommand {
  const value = storedRecord(
    input,
    "Stored Ollama command",
    [
      "schemaVersion",
      "commandId",
      "fingerprint",
      "accountId",
      "connectionId",
      "operation",
    ],
    [
      "credentialGeneration",
      "expectedGeneration",
      "label",
      "settings",
      "enabled",
      "revokeUpstream",
      "receipt",
      "completedAt",
      "automaticRefresh",
      "mutationSequence",
      "settlementEffectId",
      "settlementStatus",
      "validationCatalog",
      "validationFailure",
      "validationStatus",
      "providerRetryPolicy",
      "recoveryAttempts",
    ],
  );
  const operations: StoredCommand["operation"][] = [
    "connection/create-api-key",
    "connection/rotate-api-key",
    "connection/update-label",
    "connection/refresh-models",
    "connection/set-enabled",
    "connection/disconnect",
  ];
  if (
    value.schemaVersion !== 1 ||
    !operations.includes(value.operation as never) ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    (value.revokeUpstream !== undefined &&
      typeof value.revokeUpstream !== "boolean") ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== "number" ||
        !Number.isSafeInteger(value.completedAt) ||
        value.completedAt < 0)) ||
    (value.automaticRefresh !== undefined &&
      typeof value.automaticRefresh !== "boolean") ||
    (value.mutationSequence !== undefined &&
      (typeof value.mutationSequence !== "number" ||
        !Number.isSafeInteger(value.mutationSequence) ||
        value.mutationSequence <= 0)) ||
    (value.settlementStatus !== undefined &&
      value.settlementStatus !== "applied" &&
      value.settlementStatus !== "failed") ||
    Boolean(value.settlementEffectId) !== Boolean(value.settlementStatus) ||
    (value.validationStatus !== undefined &&
      value.validationStatus !== "applied" &&
      value.validationStatus !== "failed") ||
    (value.validationStatus === "applied") !==
      (value.validationCatalog !== undefined) ||
    (value.validationStatus === "failed") !==
      (value.validationFailure !== undefined) ||
    (value.providerRetryPolicy !== undefined &&
      value.providerRetryPolicy !== "safe-metadata-read")
  ) {
    throw new Error("Stored Ollama command is invalid");
  }
  const commandId = storedText(value.commandId, "commandId", 128);
  const connectionId = storedText(value.connectionId, "connectionId", 128);
  const decodedReceipt =
    value.receipt === undefined
      ? undefined
      : decodeConnectionCommandReceiptV1(value.receipt);
  const validationCatalog =
    value.validationCatalog === undefined
      ? undefined
      : decodeConnectionModelCatalogV1(value.validationCatalog);
  if (
    decodedReceipt &&
    (decodedReceipt.commandId !== commandId ||
      decodedReceipt.connectionId !== connectionId)
  ) {
    throw new Error("Stored Ollama command receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId,
    fingerprint: storedText(value.fingerprint, "fingerprint", 64),
    accountId: storedText(value.accountId, "accountId", 256),
    connectionId,
    operation: value.operation as StoredCommand["operation"],
    ...(value.credentialGeneration === undefined
      ? {}
      : {
          credentialGeneration: storedText(
            value.credentialGeneration,
            "credentialGeneration",
            128,
          ),
        }),
    ...(value.expectedGeneration === undefined
      ? {}
      : {
          expectedGeneration: storedText(
            value.expectedGeneration,
            "expectedGeneration",
            128,
          ),
        }),
    ...(value.label === undefined
      ? {}
      : { label: storedText(value.label, "label", 120) }),
    ...(value.settings === undefined
      ? {}
      : { settings: decodeStoredConnectionSettings(value.settings) }),
    ...(value.enabled === undefined
      ? {}
      : { enabled: value.enabled as boolean }),
    ...(value.revokeUpstream === undefined
      ? {}
      : { revokeUpstream: value.revokeUpstream as boolean }),
    ...(decodedReceipt === undefined ? {} : { receipt: decodedReceipt }),
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: value.completedAt as number }),
    ...(value.automaticRefresh === undefined
      ? {}
      : { automaticRefresh: value.automaticRefresh as boolean }),
    ...(value.mutationSequence === undefined
      ? {}
      : { mutationSequence: value.mutationSequence as number }),
    ...(value.settlementEffectId === undefined
      ? {}
      : {
          settlementEffectId: storedText(
            value.settlementEffectId,
            "settlementEffectId",
            256,
          ),
          settlementStatus: value.settlementStatus as "applied" | "failed",
        }),
    ...(value.validationStatus === undefined
      ? {}
      : {
          validationStatus: value.validationStatus as "applied" | "failed",
          ...(validationCatalog ? { validationCatalog } : {}),
          ...(value.validationFailure === undefined
            ? {}
            : {
                validationFailure: storedText(
                  value.validationFailure,
                  "validationFailure",
                  500,
                ),
              }),
        }),
    ...(value.providerRetryPolicy === undefined
      ? {}
      : { providerRetryPolicy: "safe-metadata-read" as const }),
  };
}

function decodeStoredModelResolution(input: unknown): StoredModelResolution {
  const value = storedRecord(
    input,
    "Stored Ollama model resolution",
    [
      "schemaVersion",
      "effectId",
      "accountId",
      "connectionId",
      "connectionGeneration",
      "providerModelId",
      "retryPolicy",
      "status",
    ],
    ["model", "failure"],
  );
  const status = value.status;
  if (
    value.schemaVersion !== 1 ||
    value.retryPolicy !== "safe-metadata-read" ||
    (status !== "pending" && status !== "applied" && status !== "failed") ||
    (status === "applied") !== (value.model !== undefined) ||
    (status === "failed") !== (value.failure !== undefined)
  ) {
    throw new Error("Stored Ollama model resolution is invalid");
  }
  const model =
    value.model === undefined
      ? undefined
      : decodeConnectionModelCatalogV1({
          schemaVersion: 1,
          generation: "resolution-journal",
          state: "fresh",
          models: [value.model],
        }).models[0];
  return {
    schemaVersion: 1,
    effectId: storedText(value.effectId, "effectId", 256),
    accountId: storedText(value.accountId, "accountId", 256),
    connectionId: storedText(value.connectionId, "connectionId", 128),
    connectionGeneration: storedText(
      value.connectionGeneration,
      "connectionGeneration",
      128,
    ),
    providerModelId: storedText(value.providerModelId, "providerModelId", 256),
    retryPolicy: "safe-metadata-read",
    status,
    ...(model ? { model } : {}),
    ...(value.failure === undefined
      ? {}
      : { failure: storedText(value.failure, "failure", 500) }),
  };
}

function decodeMutationSequence(input: unknown): {
  next: number;
  applied: number;
} {
  const value = storedRecord(input, "Stored Ollama mutation sequence", [
    "schemaVersion",
    "next",
    "applied",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.next !== "number" ||
    !Number.isSafeInteger(value.next) ||
    value.next < 0 ||
    typeof value.applied !== "number" ||
    !Number.isSafeInteger(value.applied) ||
    value.applied < 0 ||
    value.applied > value.next
  ) {
    throw new Error("Stored Ollama mutation sequence is invalid");
  }
  return { next: value.next, applied: value.applied };
}

function compactCompletedCommand(
  record: StoredCommand,
): StoredCommandTombstone {
  if (!record.receipt || record.completedAt === undefined) {
    throw new Error("Completed Ollama command receipt is unavailable");
  }
  return {
    schemaVersion: 1,
    commandId: record.commandId,
    fingerprint: record.fingerprint,
    accountId: record.accountId,
    connectionId: record.connectionId,
    operation: record.operation,
    receipt: record.receipt,
    completedAt: record.completedAt,
  };
}

function isSequencedMutation(operation: StoredCommand["operation"]): boolean {
  return (
    operation === "connection/update-label" ||
    operation === "connection/set-enabled" ||
    operation === "connection/refresh-models"
  );
}

function retainResolvedModel(
  catalog: ConnectionModelCatalogV1,
  resolved: ConnectionModelCatalogV1["models"][number],
): ConnectionModelCatalogV1["models"] {
  const discovered = catalog.models
    .filter((model) => model.source === "discovered")
    .slice(0, MAX_DISCOVERED_MODELS);
  const available = MAX_CONNECTION_MODELS - discovered.length;
  if (available === 0) return discovered;
  const exact = [
    ...catalog.models.filter(
      (model) =>
        model.source === "exact-resolution" &&
        model.providerModelId !== resolved.providerModelId,
    ),
    resolved,
  ];
  return [...discovered, ...exact.slice(-available)];
}

export class OllamaCloudUserBackendContribution {
  readonly packageId = PACKAGE_ID;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly resumptions = new Map<
    string,
    { fingerprint: string; promise: Promise<ConnectionCommandReceiptV1> }
  >();

  constructor(private readonly host: OllamaUserBackendHost) {
    this.now = host.now ?? Date.now;
    this.randomId = host.randomId ?? crypto.randomUUID.bind(crypto);
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    return this.executeCommand(
      accountId,
      decodeConnectionCommandV1(input),
      false,
    );
  }

  async lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    await this.host.settings.read(accountId);
    const value = await this.host.storage.get<unknown>(commandKey(commandId));
    const tombstonesValue = await this.host.storage.get<unknown>(
      COMMAND_TOMBSTONES_KEY,
    );
    const record =
      value === undefined
        ? (tombstonesValue === undefined
            ? []
            : decodeCommandTombstones(tombstonesValue)
          ).find((candidate) => candidate.commandId === commandId)
        : decodeStoredCommand(value);
    if (!record) return undefined;
    if (record.accountId !== accountId) {
      throw new Error("Connection command authority does not match");
    }
    return record.receipt;
  }

  private async executeCommand(
    accountId: string,
    command: ConnectionCommandV1,
    automaticRefresh: boolean,
  ): Promise<ConnectionCommandReceiptV1> {
    const storedAccountValue =
      await this.host.storage.get<unknown>(ACCOUNT_KEY);
    const storedAccount =
      storedAccountValue === undefined
        ? undefined
        : decodeStoredAccount(storedAccountValue);
    if (storedAccount && storedAccount !== accountId) {
      throw new Error("Ollama Connection authority does not match");
    }
    if (!storedAccount) await this.host.storage.put(ACCOUNT_KEY, accountId);
    const commandFingerprint = await fingerprint(command);
    const existingValue = await this.host.storage.get<unknown>(
      commandKey(command.commandId),
    );
    const existing =
      existingValue === undefined
        ? undefined
        : decodeStoredCommand(existingValue);
    if (existing) {
      if (
        existing.accountId !== accountId ||
        existing.fingerprint !== commandFingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      if (existing.receipt) return existing.receipt;
      return this.resumeOnce(
        existing,
        command.type === "connection/create-api-key" ||
          command.type === "connection/rotate-api-key"
          ? command.apiKey
          : undefined,
      );
    }
    const tombstonesValue = await this.host.storage.get<unknown>(
      COMMAND_TOMBSTONES_KEY,
    );
    const tombstone = (
      tombstonesValue === undefined
        ? []
        : decodeCommandTombstones(tombstonesValue)
    ).find((candidate) => candidate.commandId === command.commandId);
    if (tombstone) {
      if (
        tombstone.accountId !== accountId ||
        tombstone.fingerprint !== commandFingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      return tombstone.receipt;
    }

    const record = await this.admit(
      accountId,
      command,
      commandFingerprint,
      automaticRefresh,
    );
    return record.receipt ?? this.resumeOnce(record);
  }

  private async admit(
    accountId: string,
    command: ConnectionCommandV1,
    commandFingerprint: string,
    automaticRefresh: boolean,
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
      // An unusable endpoint is admitted and then refused, so the User sees a
      // failed receipt and a failed Connection carrying the reason rather than
      // an unhandled throw. No provider request is made for it.
      let accepted: Record<string, string> = {};
      let settingsFailure: string | undefined;
      try {
        accepted = decodeOllamaConnectionSettings(command.settings);
      } catch (error) {
        settingsFailure = (
          error instanceof Error && error.message
            ? error.message
            : "Ollama Cloud Connection settings are invalid"
        ).slice(0, 500);
      }
      const record: StoredCommand = {
        schemaVersion: 1,
        commandId: command.commandId,
        fingerprint: commandFingerprint,
        accountId,
        connectionId,
        credentialGeneration: generation,
        operation: command.type,
        label: command.label,
        ...(Object.keys(accepted).length > 0 ? { settings: accepted } : {}),
        providerRetryPolicy: "safe-metadata-read",
        ...(settingsFailure === undefined
          ? {}
          : {
              validationFailure: settingsFailure,
              validationStatus: "failed" as const,
            }),
      };
      const prepared = await this.host.credentials.prepareApiKey({
        accountId,
        connectionId,
        packageId: PACKAGE_ID,
        generation,
        apiKey: command.apiKey,
      });
      const admitted = await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const admission = await this.admitRecord(record, storage);
          if (!admission.created) return admission.record;
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
          return record;
        },
      );
      await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      return admitted;
    }

    if (command.type === "connection/create") {
      throw new Error("Ollama Cloud Connections require an API key");
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
        providerRetryPolicy: "safe-metadata-read",
      };
      const prepared = await this.host.credentials.prepareApiKey({
        accountId,
        connectionId: connection.connectionId,
        packageId: PACKAGE_ID,
        generation,
        apiKey: command.apiKey,
      });
      const admitted = await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const admission = await this.admitRecord(record, storage);
          if (!admission.created) return admission.record;
          const settings = await this.host.settings.readSnapshot(storage);
          const current = settings.connections.find(
            (candidate) => candidate.connectionId === connection.connectionId,
          );
          if (
            !settings.packages.some(
              (pkg) =>
                pkg.packageId === PACKAGE_ID && pkg.state === "installed",
            ) ||
            !current ||
            current.generation !== connection.generation ||
            (current.state !== "ready" && current.state !== "disabled")
          ) {
            throw new Error("Connection changed before credential rotation");
          }
          await this.host.credentials.stagePreparedApiKey(prepared, storage);
          return record;
        },
      );
      await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      return admitted;
    }

    const record: StoredCommand = {
      schemaVersion: 1,
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      accountId,
      connectionId: connection.connectionId,
      expectedGeneration: connection.generation,
      operation: command.type,
      ...(command.type === "connection/refresh-models"
        ? { providerRetryPolicy: "safe-metadata-read" as const }
        : {}),
      ...(command.type === "connection/update-label"
        ? { label: command.label }
        : {}),
      ...(command.type === "connection/set-enabled"
        ? { enabled: command.enabled }
        : {}),
      ...(command.type === "connection/disconnect"
        ? { revokeUpstream: command.revokeUpstream }
        : {}),
      ...(automaticRefresh ? { automaticRefresh: true } : {}),
    };
    const admitted = await this.admitRecord(record);
    await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
    return admitted.record;
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
  ): Promise<{ record: StoredCommand; created: boolean }> {
    const admit = async (transaction: CredentialTransaction) => {
      const existingValue = await transaction.get<unknown>(
        commandKey(record.commandId),
      );
      const tombstonesValue = await transaction.get<unknown>(
        COMMAND_TOMBSTONES_KEY,
      );
      const tombstones =
        tombstonesValue === undefined
          ? []
          : decodeCommandTombstones(tombstonesValue);
      const tombstone = tombstones.find(
        (candidate) => candidate.commandId === record.commandId,
      );
      if (tombstone) {
        if (
          tombstone.accountId !== record.accountId ||
          tombstone.fingerprint !== record.fingerprint
        ) {
          throw new Error("Connection command idempotency key was reused");
        }
        return { record: tombstone, created: false };
      }
      const existing =
        existingValue === undefined
          ? undefined
          : decodeStoredCommand(existingValue);
      if (existing) {
        if (
          existing.accountId !== record.accountId ||
          existing.fingerprint !== record.fingerprint
        ) {
          throw new Error("Connection command idempotency key was reused");
        }
        return { record: existing, created: false };
      }
      const pendingValue = await transaction.get<unknown>(PENDING_KEY);
      const pending = (
        pendingValue === undefined ? [] : decodePendingCommands(pendingValue)
      ).filter((id) => id !== record.commandId);
      if (pending.length >= MAX_PENDING_COMMANDS) {
        throw new Error("Ollama Connection command capacity reached");
      }
      if (!record.automaticRefresh) {
        const receiptIndexValue =
          await transaction.get<unknown>(RECEIPT_INDEX_KEY);
        const receiptIndex =
          receiptIndexValue === undefined
            ? []
            : decodeReceiptIndex(receiptIndexValue);
        if (
          receiptIndex.length + tombstones.length + pending.length >=
          MAX_MANUAL_COMMANDS
        ) {
          throw new Error("Ollama Connection command history capacity reached");
        }
      }
      let admitted = record;
      let sequenceEntry: Record<string, unknown> = {};
      if (isSequencedMutation(record.operation)) {
        const sequenceValue = await transaction.get<unknown>(
          mutationSequenceKey(record.connectionId, record.operation),
        );
        const sequence =
          sequenceValue === undefined
            ? { next: 0, applied: 0 }
            : decodeMutationSequence(sequenceValue);
        const next = sequence.next + 1;
        admitted = { ...record, mutationSequence: next };
        sequenceEntry = {
          [mutationSequenceKey(record.connectionId, record.operation)]: {
            schemaVersion: 1,
            next,
            applied: sequence.applied,
          },
        };
      }
      await transaction.put({
        [commandKey(record.commandId)]: admitted,
        [PENDING_KEY]: [...pending, record.commandId],
        ...sequenceEntry,
      });
      await transaction.setAlarm?.(this.now() + RECOVERY_DELAY_MS);
      return { record: admitted, created: true };
    };
    return storage ? admit(storage) : this.host.storage.transaction(admit);
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
      settings: { ...(record.settings ?? {}) },
      safeMetadata: { creationCommandId: record.commandId },
    };
  }

  private async resumeOnce(
    record: StoredCommand,
    apiKey?: string,
  ): Promise<ConnectionCommandReceiptV1> {
    const active = this.resumptions.get(record.commandId);
    if (active) {
      if (active.fingerprint !== record.fingerprint) {
        throw new Error("Connection command idempotency key was reused");
      }
      return active.promise;
    }
    const promise = (async () => {
      try {
        const sequenced = await this.ensureMutationSequence(record);
        await this.ensureAdmittedState(sequenced, apiKey);
        return await this.resume(sequenced);
      } catch (error) {
        await this.host.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
        throw error;
      }
    })();
    this.resumptions.set(record.commandId, {
      fingerprint: record.fingerprint,
      promise,
    });
    const release = () => {
      if (this.resumptions.get(record.commandId)?.promise === promise) {
        this.resumptions.delete(record.commandId);
      }
    };
    void promise.then(release, release);
    return promise;
  }

  private async ensureMutationSequence(
    record: StoredCommand,
  ): Promise<StoredCommand> {
    if (!isSequencedMutation(record.operation) || record.mutationSequence) {
      return record;
    }
    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const storedValue = await storage.get<unknown>(
          commandKey(record.commandId),
        );
        if (storedValue === undefined) return record;
        const stored = decodeStoredCommand(storedValue);
        if (stored.mutationSequence) return stored;
        const sequenceValue = await storage.get<unknown>(
          mutationSequenceKey(record.connectionId, record.operation),
        );
        const sequence =
          sequenceValue === undefined
            ? { next: 0, applied: 0 }
            : decodeMutationSequence(sequenceValue);
        const next = sequence.next + 1;
        const sequenced = { ...stored, mutationSequence: next };
        await storage.put({
          [commandKey(record.commandId)]: sequenced,
          [mutationSequenceKey(record.connectionId, record.operation)]: {
            schemaVersion: 1,
            next,
            applied: sequence.applied,
          },
        });
        return sequenced;
      },
    );
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
      models: models.slice(0, MAX_DISCOVERED_MODELS),
      refreshedAt: new Date(now).toISOString(),
      refreshAfter: new Date(now + REFRESH_INTERVAL_MS).toISOString(),
    };
  }

  private async validateAndActivate(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const generation = record.credentialGeneration;
    if (!generation) throw new Error("Credential generation is unavailable");
    const effectId = `validation:${record.commandId}`;
    let outcome = record;
    const existingProjection = await this.requireConnection(
      record.accountId,
      record.connectionId,
    );
    if (
      !outcome.validationStatus &&
      existingProjection.generation === generation &&
      (existingProjection.state === "ready" ||
        existingProjection.state === "disabled")
    ) {
      return this.finishRecord(record, "applied");
    }
    if (!outcome.validationStatus) {
      try {
        if (outcome.providerRetryPolicy !== "safe-metadata-read") {
          throw new Error("Ollama validation retry policy is unavailable");
        }
        const lease = await this.host.credentials.lease({
          accountId: record.accountId,
          connectionId: record.connectionId,
          packageId: PACKAGE_ID,
          effectId,
          expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
          expectedGeneration: generation,
          credentialState: "pending",
        });
        const apiKey = await this.host.credentials.openLease({
          accountId: record.accountId,
          packageId: PACKAGE_ID,
          lease,
        });
        // A catalog read is not validation: measured against https://ollama.com
        // on 2026-08-31, `GET /api/tags`, `GET /v1/models`, and `POST
        // /api/show` all answer 200 for a valid key, a garbage key, and no key
        // at all (docs/research/ollama-cloud-auth.md), so `listModels` alone
        // promotes a bad key to `ready` and the User only learns it is bad when
        // a Turn ends `model-error`. `POST /api/chat` authenticates, so a
        // one-token completion is what proves the key.
        const client = this.clientFor(
          record.settings?.[API_BASE_URL_SETTING] ??
            connectionApiBaseUrl(existingProjection),
        );
        const models = await client.listModels(apiKey);
        await client.probeInference(apiKey, probeModelId(models));
        outcome = {
          ...record,
          validationCatalog: this.catalog(models),
          validationStatus: "applied",
        };
      } catch (error) {
        outcome = {
          ...record,
          validationFailure: (error instanceof Error && error.message
            ? error.message
            : "Ollama Cloud validation failed"
          ).slice(0, 500),
          validationStatus: "failed",
        };
      }
      await this.host.storage.transaction(async (storage) => {
        const storedValue = await storage.get<unknown>(
          commandKey(record.commandId),
        );
        if (storedValue === undefined) {
          throw new Error("Ollama Connection command is unavailable");
        }
        const stored = decodeStoredCommand(storedValue);
        if (!stored.receipt) {
          await storage.put(commandKey(record.commandId), outcome);
        }
      });
    }
    const settleValidation = () =>
      this.host.credentials.settle({
        accountId: record.accountId,
        connectionId: record.connectionId,
        packageId: PACKAGE_ID,
        effectId,
      });
    let projected: ConnectionView;
    try {
      projected = await this.requireConnection(
        record.accountId,
        record.connectionId,
      );
    } catch (error) {
      await settleValidation();
      await this.host.credentials.discardPending(
        record.connectionId,
        generation,
      );
      const settledValue = await this.host.storage.get<unknown>(
        commandKey(record.commandId),
      );
      const settled =
        settledValue === undefined
          ? undefined
          : decodeStoredCommand(settledValue).receipt;
      if (settled) return settled;
      throw error;
    }
    if (
      projected.generation === generation &&
      (projected.state === "ready" || projected.state === "disabled")
    ) {
      await settleValidation();
      return this.finishRecord(outcome, "applied");
    }
    if (outcome.validationStatus === "failed") {
      await settleValidation();
      await this.host.credentials.discardPending(
        record.connectionId,
        generation,
      );
      if (
        record.operation === "connection/create-api-key" &&
        projected.state === "authorizing" &&
        projected.generation === generation
      ) {
        await this.host.settings.replaceConnection(
          record.accountId,
          record.connectionId,
          projected.generation,
          {
            ...projected,
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
            failure: outcome.validationFailure,
          },
        );
      }
      return this.finishRecord(outcome, "failed");
    }
    try {
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
              modelCatalog: outcome.validationCatalog,
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
    } catch (error) {
      await settleValidation();
      await this.host.credentials.discardPending(
        record.connectionId,
        generation,
      );
      const settledValue = await this.host.storage.get<unknown>(
        commandKey(record.commandId),
      );
      const settled =
        settledValue === undefined
          ? undefined
          : decodeStoredCommand(settledValue).receipt;
      if (settled) return settled;
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
      return this.finishRecord(outcome, "failed");
    }
    await settleValidation();
    return this.finishRecord(outcome, "applied");
  }

  private async updateLabel(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const label = record.label;
    if (!label) return this.finishRecord(record, "failed");
    const applied = await this.applySequencedMutation(record, (current) => ({
      ...current,
      displayName: label,
    }));
    return this.finishRecord(record, applied ? "applied" : "failed");
  }

  private async refreshCatalog(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const expectedGeneration = record.expectedGeneration;
    if (!expectedGeneration) return this.finishRecord(record, "failed");
    if (record.settlementEffectId && record.settlementStatus) {
      await this.host.credentials.settle({
        accountId: record.accountId,
        connectionId: record.connectionId,
        packageId: PACKAGE_ID,
        effectId: record.settlementEffectId,
      });
      return this.finishRecord(record, record.settlementStatus);
    }
    if (record.providerRetryPolicy !== "safe-metadata-read") {
      return this.finishRecord(record, "failed");
    }
    const effectId = `catalog:${record.commandId}`;
    let lease: CredentialLeaseV1 | undefined;
    let models: ConnectionModelCatalogV1["models"] | undefined;
    let failure: unknown;
    let refreshEndpoint: string | undefined;
    try {
      lease = await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          const authority = await this.requireModelAuthority(
            {
              accountId: record.accountId,
              connectionId: record.connectionId,
              connectionGeneration: expectedGeneration,
            },
            storage,
          );
          refreshEndpoint = connectionApiBaseUrl(authority);
          return this.host.credentials.lease(
            {
              accountId: record.accountId,
              connectionId: record.connectionId,
              packageId: PACKAGE_ID,
              effectId,
              expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
              expectedGeneration,
            },
            storage,
          );
        },
      );
      const apiKey = await this.host.credentials.openLease({
        accountId: record.accountId,
        packageId: PACKAGE_ID,
        lease,
      });
      models = await this.clientFor(refreshEndpoint).listModels(apiKey);
    } catch (error) {
      failure = error;
    }
    const outcome = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        let outcomeModels = models;
        let outcomeFailure = failure;
        let authorized: ConnectionView | undefined;
        const mutationSequenceValue = record.mutationSequence
          ? await storage.get<unknown>(
              mutationSequenceKey(record.connectionId, record.operation),
            )
          : undefined;
        const mutationSequence =
          mutationSequenceValue === undefined
            ? undefined
            : decodeMutationSequence(mutationSequenceValue);
        const appliesProjection =
          !record.mutationSequence ||
          !mutationSequence ||
          record.mutationSequence === mutationSequence.next;
        if (outcomeModels) {
          try {
            authorized = await this.requireModelAuthority(
              {
                accountId: record.accountId,
                connectionId: record.connectionId,
                connectionGeneration: expectedGeneration,
              },
              storage,
            );
          } catch (error) {
            outcomeModels = undefined;
            outcomeFailure = error;
          }
        }
        const status: ConnectionCommandReceiptV1["status"] =
          appliesProjection && outcomeFailure === undefined
            ? "applied"
            : "failed";
        const pendingSettlement: StoredCommand | undefined = lease
          ? {
              ...record,
              settlementEffectId: effectId,
              settlementStatus: status,
            }
          : undefined;
        if (appliesProjection && outcomeModels && authorized) {
          await this.host.settings.replaceConnection(
            record.accountId,
            record.connectionId,
            expectedGeneration,
            {
              ...authorized,
              modelCatalog: this.catalog(outcomeModels),
              failure: undefined,
            },
            storage,
          );
        } else if (appliesProjection) {
          const settings = await this.host.settings.readSnapshot(storage);
          const current = settings.connections.find(
            (connection) => connection.connectionId === record.connectionId,
          );
          if (
            settings.packages.some(
              (pkg) =>
                pkg.packageId === PACKAGE_ID && pkg.state === "installed",
            ) &&
            current?.packageId === PACKAGE_ID &&
            current.generation === expectedGeneration &&
            current.state === "ready" &&
            current.modelCatalog
          ) {
            await this.host.settings.replaceConnection(
              record.accountId,
              record.connectionId,
              expectedGeneration,
              {
                ...current,
                modelCatalog: {
                  ...current.modelCatalog,
                  state: "stale",
                  refreshAfter: new Date(
                    this.now() + REFRESH_INTERVAL_MS,
                  ).toISOString(),
                  failure:
                    outcomeFailure instanceof Error
                      ? outcomeFailure.message
                      : "Ollama Cloud catalog refresh failed",
                },
              },
              storage,
            );
          }
        }
        if (appliesProjection && record.mutationSequence && mutationSequence) {
          await storage.put(
            mutationSequenceKey(record.connectionId, record.operation),
            {
              schemaVersion: 1,
              next: mutationSequence.next,
              applied: Math.max(
                mutationSequence.applied,
                record.mutationSequence,
              ),
            },
          );
        }
        if (pendingSettlement) {
          const storedValue = await storage.get<unknown>(
            commandKey(record.commandId),
          );
          if (storedValue === undefined) {
            throw new Error("Ollama Connection command is unavailable");
          }
          const stored = decodeStoredCommand(storedValue);
          if (!stored.receipt) {
            await storage.put(commandKey(record.commandId), pendingSettlement);
          }
        }
        return { status, pendingSettlement };
      },
    );
    if (!outcome.pendingSettlement) {
      return this.finishRecord(record, outcome.status);
    }
    await this.host.credentials.settle({
      accountId: record.accountId,
      connectionId: record.connectionId,
      packageId: PACKAGE_ID,
      effectId,
    });
    return this.finishRecord(outcome.pendingSettlement, outcome.status);
  }

  private async setEnabled(
    record: StoredCommand,
  ): Promise<ConnectionCommandReceiptV1> {
    const applied = await this.applySequencedMutation(record, (current) => {
      if (current.state !== "ready" && current.state !== "disabled") {
        return undefined;
      }
      return { ...current, state: record.enabled ? "ready" : "disabled" };
    });
    return this.finishRecord(record, applied ? "applied" : "failed");
  }

  private async applySequencedMutation(
    record: StoredCommand,
    update: (current: ConnectionView) => ConnectionView | undefined,
  ): Promise<boolean> {
    const mutationSequence = record.mutationSequence;
    if (!mutationSequence) return false;
    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const sequenceValue = await storage.get<unknown>(
          mutationSequenceKey(record.connectionId, record.operation),
        );
        const sequence =
          sequenceValue === undefined
            ? { next: mutationSequence, applied: 0 }
            : decodeMutationSequence(sequenceValue);
        if (mutationSequence < sequence.applied) return false;
        if (mutationSequence === sequence.applied) return true;
        const current = await this.host.settings.getConnection(
          record.accountId,
          record.connectionId,
          storage,
        );
        if (
          !current ||
          current.packageId !== PACKAGE_ID ||
          current.generation !== record.expectedGeneration
        ) {
          return false;
        }
        const updated = update(current);
        if (!updated) return false;
        await this.host.settings.replaceConnection(
          record.accountId,
          record.connectionId,
          current.generation,
          updated,
          storage,
        );
        await storage.put(
          mutationSequenceKey(record.connectionId, record.operation),
          {
            schemaVersion: 1,
            next: Math.max(sequence.next, mutationSequence),
            applied: mutationSequence,
          },
        );
        return true;
      },
    );
  }

  private async cancelPendingCredentialMutations(
    record: StoredCommand,
    storage: UserSettingsTransaction & CredentialTransaction,
  ): Promise<void> {
    const pendingValue = await storage.get<unknown>(PENDING_KEY);
    const pending =
      pendingValue === undefined ? [] : decodePendingCommands(pendingValue);
    const retained: string[] = [];
    const completedIds: string[] = [];
    const completed: Record<string, unknown> = {};
    for (const commandId of pending) {
      const value = await storage.get<unknown>(commandKey(commandId));
      if (value === undefined) continue;
      const candidate = decodeStoredCommand(value);
      if (
        (candidate.operation === "connection/create-api-key" ||
          candidate.operation === "connection/rotate-api-key") &&
        candidate.connectionId === record.connectionId &&
        !candidate.receipt
      ) {
        completed[commandKey(commandId)] = compactCompletedCommand({
          ...candidate,
          receipt: receipt(candidate, "failed"),
          completedAt: this.now(),
        });
        completedIds.push(commandId);
        if (candidate.credentialGeneration) {
          await this.host.credentials.discardPending(
            candidate.connectionId,
            candidate.credentialGeneration,
            storage,
          );
        }
      } else {
        retained.push(commandId);
      }
    }
    const receiptIndexValue = await storage.get<unknown>(RECEIPT_INDEX_KEY);
    const receiptIndex =
      receiptIndexValue === undefined
        ? []
        : decodeReceiptIndex(receiptIndexValue);
    const ordered = [
      ...receiptIndex.filter((commandId) => !completedIds.includes(commandId)),
      ...completedIds,
    ];
    const tombstonesValue = await storage.get<unknown>(COMMAND_TOMBSTONES_KEY);
    let tombstones =
      tombstonesValue === undefined
        ? []
        : decodeCommandTombstones(tombstonesValue);
    for (const commandId of ordered.slice(0, -MAX_MANUAL_RECEIPTS)) {
      const key = commandKey(commandId);
      const value = completed[key] ?? (await storage.get<unknown>(key));
      if (value === undefined) continue;
      const compacted = compactCompletedCommand(decodeStoredCommand(value));
      tombstones = [
        ...tombstones.filter((candidate) => candidate.commandId !== commandId),
        compacted,
      ];
      delete completed[key];
      await storage.delete(key);
    }
    if (tombstones.length > MAX_COMMAND_TOMBSTONES) {
      throw new Error("Ollama Connection command history capacity reached");
    }
    await storage.put({
      ...completed,
      [COMMAND_TOMBSTONES_KEY]: tombstones,
      [PENDING_KEY]: retained,
      [RECEIPT_INDEX_KEY]: ordered.slice(-MAX_MANUAL_RECEIPTS),
    });
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
        if (current.state === "revoked") {
          if (!record.revokeUpstream) return "revoked";
          await this.host.settings.replaceConnection(
            record.accountId,
            record.connectionId,
            expectedGeneration,
            {
              ...current,
              state: "reconciliation-required",
              failure:
                "Ollama Cloud does not expose upstream API-key revocation",
            },
            storage,
          );
          return "reconciliation-required";
        }
        if (current.state === "reconciliation-required") {
          return "reconciliation-required";
        }
        await this.cancelPendingCredentialMutations(record, storage);
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
    if (transition === "stale") {
      return this.finishRecord(record, "failed");
    }
    if (transition === "revoked") return this.finishRecord(record, "applied");
    if (transition === "reconciliation-required") {
      return this.finishRecord(record, "reconciliation-required");
    }

    await this.host.credentials.disconnect(record.connectionId);
    const terminalStatus = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const current = await this.host.settings.getConnection(
          record.accountId,
          record.connectionId,
          storage,
        );
        if (
          !current ||
          current.packageId !== PACKAGE_ID ||
          current.generation !== expectedGeneration
        ) {
          return "failed" as const;
        }
        if (current.state === "reconciliation-required") {
          return "reconciliation-required" as const;
        }
        const unsupportedUpstreamRevoke = record.revokeUpstream === true;
        if (current.state === "revoked" && !unsupportedUpstreamRevoke) {
          return "applied" as const;
        }
        if (current.state !== "revoking" && current.state !== "revoked") {
          return "failed" as const;
        }
        await this.host.settings.replaceConnection(
          record.accountId,
          record.connectionId,
          expectedGeneration,
          {
            ...current,
            state: unsupportedUpstreamRevoke
              ? "reconciliation-required"
              : "revoked",
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
            ...(unsupportedUpstreamRevoke
              ? {
                  failure:
                    "Ollama Cloud does not expose upstream API-key revocation",
                }
              : {}),
          },
          storage,
        );
        return unsupportedUpstreamRevoke
          ? ("reconciliation-required" as const)
          : ("applied" as const);
      },
    );
    return this.finishRecord(record, terminalStatus);
  }

  /**
   * Settle a command that has exhausted its attempts. The Connection it created
   * leaves `authorizing` for `failed` with a reason the User can act on, rather
   * than staying in a state that only a page reload even renders.
   */
  private async abandonPendingCommand(record: StoredCommand): Promise<void> {
    const failure =
      "The provider did not respond. The connection attempt was abandoned.";
    const generation = record.credentialGeneration;
    if (generation) {
      await this.host.credentials
        .discardPending(record.connectionId, generation)
        .catch(() => undefined);
    }
    const current = await this.host.settings.getConnection(
      record.accountId,
      record.connectionId,
    );
    if (
      current &&
      current.packageId === PACKAGE_ID &&
      current.state === "authorizing"
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
          failure,
        },
      );
    }
    await this.finishRecord({ ...record, validationFailure: failure }, "failed");
  }

  private async finishRecord(
    record: StoredCommand,
    status: ConnectionCommandReceiptV1["status"],
  ): Promise<ConnectionCommandReceiptV1> {
    const proposed = receipt(record, status);
    const result = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const storedValue = await storage.get<unknown>(
          commandKey(record.commandId),
        );
        const stored =
          storedValue === undefined
            ? undefined
            : decodeStoredCommand(storedValue);
        if (stored?.receipt) return stored.receipt;
        const pendingValue = await storage.get<unknown>(PENDING_KEY);
        const pending = (
          pendingValue === undefined ? [] : decodePendingCommands(pendingValue)
        ).filter((id) => id !== record.commandId);
        if (record.automaticRefresh) {
          await storage.delete(commandKey(record.commandId));
          await storage.put({
            [`${AUTOMATIC_REFRESH_RECEIPT_PREFIX}${record.connectionId}`]: {
              schemaVersion: 1,
              commandId: record.commandId,
              connectionId: record.connectionId,
              status: proposed.status,
              completedAt: new Date(this.now()).toISOString(),
            },
            [PENDING_KEY]: pending,
          });
        } else {
          const receiptIndexValue =
            await storage.get<unknown>(RECEIPT_INDEX_KEY);
          const receiptIndex =
            receiptIndexValue === undefined
              ? []
              : decodeReceiptIndex(receiptIndexValue);
          const ordered = [
            ...receiptIndex.filter(
              (commandId) => commandId !== record.commandId,
            ),
            record.commandId,
          ];
          const retained = ordered.slice(-MAX_MANUAL_RECEIPTS);
          const {
            validationCatalog: _validationCatalog,
            validationFailure: _validationFailure,
            validationStatus: _validationStatus,
            ...durableRecord
          } = stored ?? record;
          const completed = {
            ...durableRecord,
            receipt: proposed,
            completedAt: this.now(),
          };
          const tombstonesValue = await storage.get<unknown>(
            COMMAND_TOMBSTONES_KEY,
          );
          let tombstones =
            tombstonesValue === undefined
              ? []
              : decodeCommandTombstones(tombstonesValue);
          for (const commandId of ordered.slice(0, -MAX_MANUAL_RECEIPTS)) {
            const value = await storage.get<unknown>(commandKey(commandId));
            if (value === undefined) continue;
            const compacted = compactCompletedCommand(
              decodeStoredCommand(value),
            );
            tombstones = [
              ...tombstones.filter(
                (candidate) => candidate.commandId !== commandId,
              ),
              compacted,
            ];
            await storage.delete(commandKey(commandId));
          }
          if (tombstones.length > MAX_COMMAND_TOMBSTONES) {
            throw new Error(
              "Ollama Connection command history capacity reached",
            );
          }
          await storage.put({
            [commandKey(record.commandId)]: completed,
            [COMMAND_TOMBSTONES_KEY]: tombstones,
            [RECEIPT_INDEX_KEY]: retained,
            [PENDING_KEY]: pending,
          });
        }
        return proposed;
      },
    );
    await this.scheduleNextAlarm(record.accountId);
    return result;
  }

  private async scheduleNextAlarm(accountId: string): Promise<void> {
    const pendingValue = await this.host.storage.get<unknown>(PENDING_KEY);
    const pending =
      pendingValue === undefined ? [] : decodePendingCommands(pendingValue);
    const settings = await this.host.settings.read(accountId);
    const packageInstalled = settings.packages.some(
      (pkg) => pkg.packageId === PACKAGE_ID && pkg.state === "installed",
    );
    const catalogDeadlines = packageInstalled
      ? settings.connections.flatMap((connection) => {
          const refreshAfter = connection.modelCatalog?.refreshAfter;
          if (
            connection.packageId !== PACKAGE_ID ||
            connection.state !== "ready" ||
            !refreshAfter
          ) {
            return [];
          }
          const deadline = Date.parse(refreshAfter);
          return Number.isFinite(deadline)
            ? [Math.max(deadline, this.now() + RECOVERY_DELAY_MS)]
            : [];
        })
      : [];
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
    connectionGeneration: string;
  }): Promise<CredentialLeaseV1> {
    await this.host.credentials.expireLeases();
    const replay = await this.host.credentials.replayLease({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: PACKAGE_ID,
      effectId: input.effectId,
    });
    if (replay) return replay;

    const admittedGeneration = input.connectionGeneration;
    const connection = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        return this.requireModelAuthority(input, storage);
      },
    );
    const known = connection.modelCatalog?.models.some(
      (model) => model.providerModelId === input.providerModelId,
    );
    let resolvedModel: ConnectionModelCatalogV1["models"][number] | undefined;
    const resolutionKey = modelResolutionKey(input.effectId);
    if (!known) {
      const discoveryEffectId = `resolve:${input.effectId}`;
      const resolution = await this.host.storage.transaction(
        async (storage: UserSettingsTransaction & CredentialTransaction) => {
          await this.requireModelAuthority(input, storage);
          const storedValue = await storage.get<unknown>(resolutionKey);
          const stored =
            storedValue === undefined
              ? undefined
              : decodeStoredModelResolution(storedValue);
          if (
            stored &&
            (stored.effectId !== input.effectId ||
              stored.accountId !== input.accountId ||
              stored.connectionId !== input.connectionId ||
              stored.connectionGeneration !== admittedGeneration ||
              stored.providerModelId !== input.providerModelId)
          ) {
            throw new Error("Stored Ollama model resolution authority changed");
          }
          if (stored?.status === "applied" || stored?.status === "failed") {
            return { journal: stored };
          }
          const lease = await this.host.credentials.lease(
            {
              accountId: input.accountId,
              connectionId: input.connectionId,
              packageId: PACKAGE_ID,
              effectId: discoveryEffectId,
              expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
              expectedGeneration: admittedGeneration,
            },
            storage,
          );
          const journal: StoredModelResolution = stored ?? {
            schemaVersion: 1,
            effectId: input.effectId,
            accountId: input.accountId,
            connectionId: input.connectionId,
            connectionGeneration: admittedGeneration,
            providerModelId: input.providerModelId,
            retryPolicy: "safe-metadata-read",
            status: "pending",
          };
          if (!stored) await storage.put(resolutionKey, journal);
          return { journal, lease };
        },
      );
      let journal = resolution.journal;
      if (journal.status === "pending") {
        if (!resolution.lease) {
          throw new Error("Ollama model resolution lease is unavailable");
        }
        let outcome: StoredModelResolution;
        try {
          const apiKey = await this.host.credentials.openLease({
            accountId: input.accountId,
            packageId: PACKAGE_ID,
            lease: resolution.lease,
          });
          const model = await this.clientFor(
            connectionApiBaseUrl(connection),
          ).resolveModel(apiKey, input.providerModelId);
          outcome = { ...journal, status: "applied", model };
        } catch (error) {
          outcome = {
            ...journal,
            status: "failed",
            failure: (error instanceof Error && error.message
              ? error.message
              : "Ollama Cloud model resolution failed"
            ).slice(0, 500),
          };
        }
        journal = await this.host.storage.transaction(async (storage) => {
          const storedValue = await storage.get<unknown>(resolutionKey);
          if (storedValue === undefined) {
            throw new Error("Ollama model resolution journal is unavailable");
          }
          const stored = decodeStoredModelResolution(storedValue);
          if (stored.status === "pending") {
            await storage.put(resolutionKey, outcome);
            return outcome;
          }
          return stored;
        });
      }
      await this.host.credentials.settle({
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: PACKAGE_ID,
        effectId: discoveryEffectId,
      });
      if (journal.status === "failed") {
        throw new Error(journal.failure);
      }
      resolvedModel = journal.model;
    }

    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const current = await this.requireModelAuthority(input, storage);
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
                models: retainResolvedModel(catalog, resolvedModel),
              },
            },
            storage,
          );
        }
        const lease = await this.host.credentials.lease(
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
        if (!known) await storage.delete(resolutionKey);
        return lease;
      },
    );
  }

  /**
   * Lease this Connection's key for a *tool* effect — today the
   * `ollama-cloud-web-search` Capability. It is the model lease minus the
   * model: `/api/web_search` resolves nothing and bills no inference, so there
   * is no catalog to reconcile and no discovery lease to settle.
   *
   * The authority check is the same one the model path runs, and the lease is
   * keyed by the tool call's durable `effectId`, so a Turn resumed after
   * eviction replays the same lease rather than minting a second one.
   */
  async leaseToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<CredentialLeaseV1> {
    await this.host.credentials.expireLeases();
    const replay = await this.host.credentials.replayLease({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: PACKAGE_ID,
      effectId: input.effectId,
    });
    if (replay) return replay;
    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        await this.requireModelAuthority(input, storage);
        return this.host.credentials.lease(
          {
            accountId: input.accountId,
            connectionId: input.connectionId,
            packageId: PACKAGE_ID,
            effectId: input.effectId,
            expiresAt: new Date(this.now() + MODEL_LEASE_MS).toISOString(),
            expectedGeneration: input.connectionGeneration,
          },
          storage,
        );
      },
    );
  }

  private async requireModelAuthority(
    input: {
      accountId: string;
      connectionId: string;
      connectionGeneration: string;
    },
    storage: UserSettingsTransaction,
  ): Promise<ConnectionView> {
    const settings = await this.host.settings.readSnapshot(storage);
    if (
      !settings.packages.some(
        (pkg) => pkg.packageId === PACKAGE_ID && pkg.state === "installed",
      )
    ) {
      throw new Error("Ollama Cloud Package is not installed and enabled");
    }
    const connection = settings.connections.find(
      (candidate) => candidate.connectionId === input.connectionId,
    );
    if (
      !connection ||
      connection.packageId !== PACKAGE_ID ||
      connection.state !== "ready" ||
      connection.generation !== input.connectionGeneration
    ) {
      throw new Error("Connection changed before model authorization");
    }
    return connection;
  }

  /**
   * Settle a tool effect's lease. Unlike the model path there is no `resolve:`
   * companion lease and no stored model resolution, because a tool effect
   * resolves no model.
   */
  async settleToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void> {
    await this.host.credentials.settle({ ...input, packageId: PACKAGE_ID });
  }

  async settleModelCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void> {
    for (const effectId of [input.effectId, `resolve:${input.effectId}`]) {
      await this.host.credentials.settle({
        ...input,
        packageId: PACKAGE_ID,
        effectId,
      });
    }
    await this.host.storage.delete(modelResolutionKey(input.effectId));
  }

  async alarm(): Promise<void> {
    const pendingValue = await this.host.storage.get<unknown>(PENDING_KEY);
    const pending =
      pendingValue === undefined ? [] : decodePendingCommands(pendingValue);
    for (const commandId of pending.slice(
      0,
      MAX_PENDING_RECOVERIES_PER_ALARM,
    )) {
      const recordValue = await this.host.storage.get<unknown>(
        commandKey(commandId),
      );
      if (recordValue === undefined) continue;
      const record = decodeStoredCommand(recordValue);
      if (record.receipt) continue;
      const attempts = (record.recoveryAttempts ?? 0) + 1;
      if (attempts > MAX_PENDING_RECOVERY_ATTEMPTS) {
        await this.abandonPendingCommand(record);
        continue;
      }
      // Counted before the attempt, so an attempt that throws still counts and
      // the command cannot be re-driven indefinitely.
      const attempted = { ...record, recoveryAttempts: attempts };
      await this.host.storage.put({ [commandKey(commandId)]: attempted });
      await this.resumeOnce(attempted);
    }
    const accountValue = await this.host.storage.get<unknown>(ACCOUNT_KEY);
    if (accountValue === undefined) return;
    const accountId = decodeStoredAccount(accountValue);
    const settings = await this.host.settings.read(accountId);
    const packageInstalled = settings.packages.some(
      (pkg) => pkg.packageId === PACKAGE_ID && pkg.state === "installed",
    );
    if (!packageInstalled) {
      await this.scheduleNextAlarm(accountId);
      return;
    }
    const dueConnections = settings.connections
      .filter((connection) => {
        const refreshAfter = connection.modelCatalog?.refreshAfter;
        return (
          connection.packageId === PACKAGE_ID &&
          connection.state === "ready" &&
          refreshAfter !== undefined &&
          Date.parse(refreshAfter) <= this.now()
        );
      })
      .slice(0, MAX_CATALOG_REFRESHES_PER_ALARM);
    for (const connection of dueConnections) {
      const refreshAfter = connection.modelCatalog?.refreshAfter;
      if (!refreshAfter) continue;
      await this.executeCommand(
        accountId,
        decodeConnectionCommandV1({
          schemaVersion: 1,
          type: "connection/refresh-models",
          commandId: `refresh-${connection.connectionId}-${Date.parse(refreshAfter)}`,
          connectionId: connection.connectionId,
        }),
        true,
      );
    }
    await this.scheduleNextAlarm(accountId);
  }

  /**
   * The provider client for one Connection's endpoint.
   *
   * A host-supplied client wins, so a test or an embedding host can serve every
   * Connection from one stub; otherwise the host's factory, or the Package
   * default pointing at https://ollama.com, builds one per endpoint.
   */
  private clientFor(apiBaseUrl?: string): OllamaCloudClient {
    if (this.host.client) return this.host.client;
    const config: OllamaCloudClientConfig =
      apiBaseUrl === undefined ? {} : { apiBaseUrl };
    return this.host.createClient
      ? this.host.createClient(config)
      : new OllamaCloudClient(config);
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

/**
 * What an application hands this Contribution: the Ollama Cloud Connection, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface OllamaCloudUserApplicationHostV1 {
  ollamaCloud: OllamaUserBackendHost;
}

/**
 * The manifest's `user` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const userContribution = defineUserBackendContribution<
  OllamaCloudUserApplicationHostV1,
  OllamaCloudUserBackendContribution
>({
  specifier: "@frockbot/plugin-provider-ollama-cloud/user",
  create: (host, lifecycle) =>
    createOllamaCloudUserBackendPlugin(host.ollamaCloud, lifecycle),
});
