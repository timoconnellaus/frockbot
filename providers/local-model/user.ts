// The User backend Contribution for local models: the Connections that name a
// paired Mac and a model server on it.
//
// A local Connection holds no credential, so its whole lifecycle is small:
// add it (the Mac must be one of the account's, the endpoint must be on its
// loopback), ask the server for its models through the Mac, and keep that
// list. Whether the Mac is online is never stored here: a Connection stays
// `ready` while the Mac sleeps, and a Turn that needs it is told the Mac is
// offline at the moment it asks, instead of the Bot silently answering from
// another model.

import { canonicalJson, sha256 } from "@frockbot/core/contracts";
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type ConnectionModelCatalogV1,
  type ConnectionModelV1,
} from "@frockbot/core/connection";
import type { ConnectionView } from "@frockbot/core/configuration";
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import type { MachineModelRelayRequestV1 } from "@frockbot/core/machine-protocol/relay";

import {
  LOCAL_MODEL_CONNECTION_TYPE_ID,
  LOCAL_MODEL_ENDPOINT_SETTING,
  LOCAL_MODEL_LIST_FIRST_BYTE_MS,
  LOCAL_MODEL_MACHINE_SETTING,
  LOCAL_MODEL_PACKAGE_ID,
  LOCAL_MODEL_PROVIDER,
  decodeLocalModelEndpointV1,
  localModelUrlV1,
} from "./endpoint.js";

const COMMAND_PREFIX = "local-model:command:v1:";
/** The most models one server's list is kept to. */
const MAX_MODELS = 90;
/** The most of a model list read before it is refused. */
const MAX_LIST_BYTES = 2 * 1_024 * 1_024;

/** A registered machine, as the local provider needs to know it. */
export interface LocalModelMachineV1 {
  machineId: string;
  label: string;
  revoked: boolean;
}

export interface LocalModelUserBackendHost {
  storage: UserSettingsStorage;
  settings: UserSettingsBackendContribution;
  /** The account's registered machines. */
  machines(): Promise<readonly LocalModelMachineV1[]>;
  /** Sends one request to a Mac and answers its response. */
  relay(request: MachineModelRelayRequestV1): Promise<Response>;
  now?: () => number;
  randomId?: () => string;
}

interface StoredCommand {
  accountId: string;
  fingerprint: string;
  receipt: ConnectionCommandReceiptV1;
}

/** Where a Connection's model server is. */
export function localModelTargetV1(connection: ConnectionView): {
  machineId: string;
  endpoint: string;
} {
  const machineId = connection.settings?.[LOCAL_MODEL_MACHINE_SETTING];
  const endpoint = connection.settings?.[LOCAL_MODEL_ENDPOINT_SETTING];
  if (
    connection.packageId !== LOCAL_MODEL_PACKAGE_ID ||
    typeof machineId !== "string" ||
    machineId.length === 0
  ) {
    throw new Error("This local model has no Mac.");
  }
  return { machineId, endpoint: decodeLocalModelEndpointV1(endpoint) };
}

/** A server's `/models` answer, as the models a Bot may be set to. */
export function decodeLocalModelListV1(text: string): ConnectionModelV1[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The model server's list of models wasn't JSON.");
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error(
      "The model server didn't answer with a list of models. Is this its OpenAI-compatible address, ending in /v1?",
    );
  }
  const seen = new Set<string>();
  const models: ConnectionModelV1[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 256) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      providerModelId: id,
      displayName: id.slice(0, 120),
      capabilities: { tools: true, vision: false, reasoning: false },
      source: "discovered",
    });
    if (models.length >= MAX_MODELS) break;
  }
  if (models.length === 0) {
    throw new Error(
      "The model server has no models yet. Download one (for Ollama, `ollama pull llama3.2`) and try again.",
    );
  }
  return models;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_LIST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The model server's list of models was too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function message(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : "The model server could not be reached."
  ).slice(0, 500);
}

function withoutFailure(connection: ConnectionView): ConnectionView {
  const { failure: _failure, ...rest } = connection;
  return rest;
}

export class LocalModelUserBackendContribution {
  readonly packageId = LOCAL_MODEL_PACKAGE_ID;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly host: LocalModelUserBackendHost) {
    this.now = host.now ?? Date.now;
    this.randomId = host.randomId ?? (() => crypto.randomUUID());
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const key = `${COMMAND_PREFIX}${command.commandId}`;
    const fingerprint = await sha256(canonicalJson(command));
    const stored = await this.host.storage.get<StoredCommand>(key);
    if (stored) {
      if (
        stored.accountId !== accountId ||
        stored.fingerprint !== fingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      return stored.receipt;
    }
    const receipt = await this.execute(accountId, command);
    await this.host.storage.put<StoredCommand>(key, {
      accountId,
      fingerprint,
      receipt,
    });
    return receipt;
  }

  async lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    const stored = await this.host.storage.get<StoredCommand>(
      `${COMMAND_PREFIX}${commandId}`,
    );
    return stored?.accountId === accountId ? stored.receipt : undefined;
  }

  leaseModelCredential(): Promise<never> {
    return Promise.reject(new Error("A local model holds no credential"));
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  private receipt(
    command: ConnectionCommandV1,
    connectionId: string,
    status: ConnectionCommandReceiptV1["status"],
  ): ConnectionCommandReceiptV1 {
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId,
      status,
    };
  }

  private async execute(
    accountId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (command.type) {
      case "connection/create":
        return this.add(accountId, command);
      case "connection/update-label":
      case "connection/set-enabled":
      case "connection/disconnect":
      case "connection/refresh-models":
        return this.change(accountId, command);
      default:
        // No key, no sign-in: nothing else is a local model's to do.
        return this.receipt(
          command,
          "connectionId" in command && command.connectionId
            ? command.connectionId
            : "none",
          "failed",
        );
    }
  }

  private async add(
    accountId: string,
    command: Extract<ConnectionCommandV1, { type: "connection/create" }>,
  ): Promise<ConnectionCommandReceiptV1> {
    if (
      command.packageId !== LOCAL_MODEL_PACKAGE_ID ||
      command.connectionTypeId !== LOCAL_MODEL_CONNECTION_TYPE_ID ||
      !(await this.host.settings.isPackageInstalled(
        accountId,
        LOCAL_MODEL_PACKAGE_ID,
      ))
    ) {
      return this.receipt(command, "none", "failed");
    }
    const machineId = command.settings?.[LOCAL_MODEL_MACHINE_SETTING];
    const endpointInput = command.settings?.[LOCAL_MODEL_ENDPOINT_SETTING];
    const connectionId = `connection-${this.randomId()}`;
    const generation = this.randomId();
    let failure: string | undefined;
    let endpoint = "";
    try {
      endpoint = decodeLocalModelEndpointV1(endpointInput);
    } catch (error) {
      failure = message(error);
    }
    const machine = (await this.host.machines()).find(
      (candidate) => candidate.machineId === machineId && !candidate.revoked,
    );
    if (!machine) failure ??= "Choose a Mac that is paired with this account.";
    const connection: ConnectionView = {
      connectionId,
      packageId: LOCAL_MODEL_PACKAGE_ID,
      connectionTypeId: LOCAL_MODEL_CONNECTION_TYPE_ID,
      displayName: command.label.trim().slice(0, 120),
      state: "authorizing",
      generation,
      providerType: LOCAL_MODEL_PROVIDER,
      authorization: {
        schemaVersion: 1,
        kind: "none",
        credential: {
          schemaVersion: 1,
          configured: false,
          source: "none",
          writable: false,
        },
      },
      settings: {
        ...(typeof machineId === "string"
          ? { [LOCAL_MODEL_MACHINE_SETTING]: machineId }
          : {}),
        ...(endpoint ? { [LOCAL_MODEL_ENDPOINT_SETTING]: endpoint } : {}),
      },
      safeMetadata: machine ? { machineLabel: machine.label } : {},
    };
    await this.host.settings.createConnection(accountId, connection);
    if (failure) {
      await this.settle(accountId, connection, { failure });
      return this.receipt(command, connectionId, "failed");
    }
    const outcome = await this.discover(connection);
    await this.settle(accountId, connection, outcome);
    return this.receipt(
      command,
      connectionId,
      "models" in outcome ? "applied" : "failed",
    );
  }

  /** Ask the model server, through its Mac, for the models it has. */
  private async discover(
    connection: ConnectionView,
  ): Promise<{ models: ConnectionModelV1[] } | { failure: string }> {
    try {
      const { machineId, endpoint } = localModelTargetV1(connection);
      const response = await this.host.relay({
        machineId,
        relayId: `models:${this.randomId()}`,
        method: "GET",
        url: localModelUrlV1(endpoint, "models"),
        body: null,
        firstByteMs: LOCAL_MODEL_LIST_FIRST_BYTE_MS,
      });
      const text = await boundedText(response);
      if (!response.ok) {
        return {
          failure: `The model server answered ${response.status} when asked for its models. Is this its OpenAI-compatible address, ending in /v1?`,
        };
      }
      return { models: decodeLocalModelListV1(text) };
    } catch (error) {
      return { failure: message(error) };
    }
  }

  /**
   * Write what discovery found. A working Connection whose refresh failed
   * keeps its list and stays usable: the Mac may simply be asleep.
   */
  private async settle(
    accountId: string,
    connection: ConnectionView,
    outcome: { models: ConnectionModelV1[] } | { failure: string },
  ): Promise<void> {
    await this.host.storage.transaction(
      async (storage: UserSettingsTransaction) => {
        const current = await this.host.settings.getConnection(
          accountId,
          connection.connectionId,
          storage,
        );
        if (
          !current ||
          current.state === "revoked" ||
          current.generation !== connection.generation
        ) {
          return;
        }
        const refreshedAt = new Date(this.now()).toISOString();
        let next: ConnectionView;
        if ("models" in outcome) {
          const catalog: ConnectionModelCatalogV1 = {
            schemaVersion: 1,
            generation: this.randomId(),
            state: "fresh",
            models: outcome.models,
            refreshedAt,
          };
          next = {
            ...withoutFailure(current),
            state: current.state === "disabled" ? "disabled" : "ready",
            modelCatalog: catalog,
          };
        } else if (
          (current.state === "ready" || current.state === "disabled") &&
          current.modelCatalog
        ) {
          next = {
            ...current,
            modelCatalog: {
              ...current.modelCatalog,
              state: "stale",
              failure: outcome.failure,
            },
          };
        } else {
          next = { ...current, state: "failed", failure: outcome.failure };
        }
        await this.host.settings.replaceConnection(
          accountId,
          current.connectionId,
          current.generation,
          next,
          storage,
        );
      },
    );
  }

  private async change(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      {
        type:
          | "connection/update-label"
          | "connection/set-enabled"
          | "connection/disconnect"
          | "connection/refresh-models";
      }
    >,
  ): Promise<ConnectionCommandReceiptV1> {
    const connection = await this.host.settings.getConnection(
      accountId,
      command.connectionId,
    );
    if (
      !connection ||
      connection.packageId !== LOCAL_MODEL_PACKAGE_ID ||
      connection.state === "revoked"
    ) {
      return this.receipt(command, command.connectionId, "failed");
    }
    const id = connection.connectionId;
    switch (command.type) {
      case "connection/update-label":
        await this.host.settings.replaceConnection(
          accountId,
          id,
          connection.generation,
          { ...connection, displayName: command.label.trim().slice(0, 120) },
        );
        return this.receipt(command, id, "applied");
      case "connection/set-enabled":
        if (connection.state !== "ready" && connection.state !== "disabled") {
          return this.receipt(command, id, "failed");
        }
        await this.host.settings.replaceConnection(
          accountId,
          id,
          connection.generation,
          { ...connection, state: command.enabled ? "ready" : "disabled" },
        );
        return this.receipt(command, id, "applied");
      case "connection/disconnect":
        await this.host.settings.replaceConnection(
          accountId,
          id,
          connection.generation,
          { ...withoutFailure(connection), state: "revoked" },
        );
        return this.receipt(command, id, "applied");
      case "connection/refresh-models": {
        const outcome = await this.discover(connection);
        await this.settle(accountId, connection, outcome);
        return this.receipt(
          command,
          id,
          "models" in outcome ? "applied" : "failed",
        );
      }
    }
  }
}

export function createLocalModelUserBackendContribution(
  host: LocalModelUserBackendHost,
): LocalModelUserBackendContribution {
  return new LocalModelUserBackendContribution(host);
}

export interface LocalModelUserApplicationHostV1 {
  localModels: LocalModelUserBackendHost;
}

/** The manifest's User entry, resolved from the application's contribution table. */
export const userContribution = defineUserBackendContribution<
  LocalModelUserApplicationHostV1,
  LocalModelUserBackendContribution
>({
  specifier: "@frockbot/providers/local-model/user",
  mount: (host, lifecycle) =>
    lifecycle.mount(createLocalModelUserBackendContribution(host.localModels)),
});
