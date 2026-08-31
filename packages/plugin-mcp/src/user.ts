/**
 * The User Contribution: MCP servers as Connections the User owns.
 *
 * A Connection is created, validated, relabelled, disabled and disconnected
 * through the ordinary Connection command path — `connection/create` for a
 * public server, `connection/create-api-key` for one behind a key. Validation
 * is the handshake itself: `initialize` followed by `tools/list` is the only
 * thing that proves both that the endpoint speaks MCP and that the key opens
 * it, so a Connection that cannot complete it reaches `failed` with the reason
 * rather than `ready` with a promise.
 *
 * The credential never leaves this object except as an opaque, expiring lease
 * the Bot's own host opens against the keyring.
 */
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type ConnectionSettingsV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import type {
  CredentialStorage,
  CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  MCP_CONNECTION_TYPE_ID,
  MCP_KEYED_CONNECTION_TYPE_ID,
  MCP_PACKAGE_ID,
  decodeMcpConnectionSettingsV1,
} from "./agent.js";
import { McpClient, type McpFetch } from "./mcp-client.js";

/**
 * The global `fetch`, bound. A bare reference to it throws "Illegal
 * invocation" inside a Durable Object, where the built-in checks its
 * receiver.
 */
const boundFetch: McpFetch = (input, init) => fetch(input, init);

const COMMAND_PREFIX = "mcp-connection-command:";
const MAX_STORED_COMMANDS = 256;
const COMMAND_INDEX_KEY = "mcp-connection-command-index";
/** Long enough for one mount's handshake, short enough to be worth nothing. */
const TOOL_LEASE_MS = 5 * 60 * 1_000;

interface StoredCommand {
  schemaVersion: 1;
  commandId: string;
  fingerprint: string;
  connectionId: string;
  receipt: ConnectionCommandReceiptV1;
}

export interface McpUserBackendHost {
  storage: UserSettingsStorage & CredentialStorage;
  settings: UserSettingsBackendContribution;
  credentials: CredentialUserBackendContribution;
  /** The Package's own outbound seam; the deployment's `fetch` by default. */
  fetch?: McpFetch;
  now?: () => number;
  randomId?: () => string;
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

/** The identity of a server's tool set, so a change in it is observable. */
export async function mcpToolsHashV1(
  tools: readonly { name: string; inputSchema: unknown }[],
): Promise<string> {
  const canonical = [...tools]
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return (await fingerprint(canonical)).slice(0, 32);
}

function decodeStoredCommand(input: unknown): StoredCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored MCP Connection command is invalid");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "commandId",
    "fingerprint",
    "connectionId",
    "receipt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.commandId !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.connectionId !== "string" ||
    !value.receipt ||
    typeof value.receipt !== "object" ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("Stored MCP Connection command is invalid");
  }
  return value as unknown as StoredCommand;
}

export class McpUserBackendContribution {
  readonly packageId = MCP_PACKAGE_ID;

  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly host: McpUserBackendHost) {
    this.now = host.now ?? (() => Date.now());
    this.randomId = host.randomId ?? (() => crypto.randomUUID());
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const commandFingerprint = await fingerprint(command);
    const stored = await this.readCommand(command.commandId);
    if (stored) {
      if (stored.fingerprint !== commandFingerprint) {
        throw new Error(
          `MCP Connection command "${command.commandId}" was reused for a different command`,
        );
      }
      return stored.receipt;
    }
    const receipt = await this.apply(accountId, command);
    await this.recordCommand({
      schemaVersion: 1,
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      connectionId: receipt.connectionId,
      receipt,
    });
    return receipt;
  }

  async lookupConnectionCommand(
    _accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    return (await this.readCommand(commandId))?.receipt;
  }

  /**
   * MCP Connections carry tools, never a model. The seam exists because every
   * Connection Package answers the same RPC; answering it honestly is a
   * refusal, not a silent success.
   */
  leaseModelCredential(): Promise<never> {
    return Promise.reject(new Error("MCP Connections offer no model"));
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * One expiring lease over a keyed server's credential, for one mount. The
   * Bot's own host opens it against the keyring; the plaintext never crosses
   * this seam.
   */
  async leaseToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<CredentialLeaseV1> {
    const connection = await this.requireConnection(
      input.accountId,
      input.connectionId,
    );
    if (
      connection.connectionTypeId !== MCP_KEYED_CONNECTION_TYPE_ID ||
      connection.state !== "ready"
    ) {
      throw new Error("MCP Connection carries no credential");
    }
    if (connection.generation !== input.connectionGeneration) {
      throw new Error("MCP Connection generation changed");
    }
    return this.host.credentials.lease({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: MCP_PACKAGE_ID,
      effectId: input.effectId,
      expiresAt: new Date(this.now() + TOOL_LEASE_MS).toISOString(),
      expectedGeneration: input.connectionGeneration,
    });
  }

  async settleToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void> {
    await this.host.credentials.settle({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: MCP_PACKAGE_ID,
      effectId: input.effectId,
    });
  }

  private async apply(
    accountId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (command.type) {
      case "connection/create":
      case "connection/create-api-key":
        return this.create(accountId, command);
      case "connection/rotate-api-key":
        return this.rotate(accountId, command.commandId, command.connectionId, {
          apiKey: command.apiKey,
        });
      case "connection/update-label": {
        const connection = await this.requireConnection(
          accountId,
          command.connectionId,
        );
        await this.host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, displayName: command.label },
        );
        return this.receipt(command.commandId, connection.connectionId);
      }
      case "connection/set-enabled": {
        const connection = await this.requireConnection(
          accountId,
          command.connectionId,
        );
        if (connection.state === "revoked" || connection.state === "revoking") {
          throw new Error("MCP Connection is revoked");
        }
        await this.host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          {
            ...connection,
            state: command.enabled ? "ready" : "disabled",
          },
        );
        return this.receipt(command.commandId, connection.connectionId);
      }
      case "connection/disconnect": {
        const connection = await this.requireConnection(
          accountId,
          command.connectionId,
        );
        await this.host.credentials.disconnect(connection.connectionId);
        await this.host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, state: "revoked", failure: undefined },
        );
        return this.receipt(command.commandId, connection.connectionId);
      }
      case "connection/refresh-models":
        throw new Error("MCP Connections offer no model catalog");
    }
  }

  private async create(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      { type: "connection/create" | "connection/create-api-key" }
    >,
  ): Promise<ConnectionCommandReceiptV1> {
    const keyed = command.type === "connection/create-api-key";
    const expectedType = keyed
      ? MCP_KEYED_CONNECTION_TYPE_ID
      : MCP_CONNECTION_TYPE_ID;
    if (command.connectionTypeId !== expectedType) {
      throw new Error(
        `MCP Connection Type "${command.connectionTypeId}" does not accept this command`,
      );
    }
    // Decoded before anything durable happens: a URL the SSRF rules refuse is
    // never recorded as a Connection at all.
    decodeMcpConnectionSettingsV1(command.settings);
    const connectionId = `mcp-${this.randomId()}`;
    const generation = this.randomId();
    if (keyed) {
      await this.host.credentials.stageApiKey({
        accountId,
        connectionId,
        packageId: MCP_PACKAGE_ID,
        generation,
        apiKey: command.apiKey,
      });
    }
    const connection: ConnectionView = {
      connectionId,
      packageId: MCP_PACKAGE_ID,
      connectionTypeId: command.connectionTypeId,
      displayName: command.label,
      state: "authorizing",
      generation,
      providerType: "mcp",
      ...(command.settings === undefined
        ? {}
        : { settings: command.settings as ConnectionSettingsV1 }),
      safeMetadata: {},
    };
    await this.host.settings.createConnection(accountId, connection);
    return this.validateAndActivate(
      accountId,
      command.commandId,
      connection,
      keyed,
    );
  }

  private async rotate(
    accountId: string,
    commandId: string,
    connectionId: string,
    input: { apiKey: string },
  ): Promise<ConnectionCommandReceiptV1> {
    const current = await this.requireConnection(accountId, connectionId);
    if (current.connectionTypeId !== MCP_KEYED_CONNECTION_TYPE_ID) {
      throw new Error("MCP Connection carries no credential");
    }
    const generation = this.randomId();
    await this.host.credentials.stageApiKey({
      accountId,
      connectionId,
      packageId: MCP_PACKAGE_ID,
      generation,
      apiKey: input.apiKey,
    });
    const next = await this.host.settings.replaceConnection(
      accountId,
      connectionId,
      current.generation,
      { ...current, generation, state: "authorizing", failure: undefined },
    );
    return this.validateAndActivate(accountId, commandId, next, true);
  }

  /**
   * The handshake that decides a Connection's state. Success activates the
   * credential generation and records what the server said about itself;
   * failure leaves a `failed` Connection carrying the reason, which is the
   * only durable place a User can read it.
   */
  private async validateAndActivate(
    accountId: string,
    commandId: string,
    connection: ConnectionView,
    keyed: boolean,
  ): Promise<ConnectionCommandReceiptV1> {
    const generation = connection.generation!;
    let client: McpClient | undefined;
    try {
      const settings = decodeMcpConnectionSettingsV1(connection.settings);
      const apiKey = keyed
        ? await this.host.credentials.readStagedApiKey({
            accountId,
            connectionId: connection.connectionId,
            packageId: MCP_PACKAGE_ID,
            generation,
          })
        : undefined;
      client = new McpClient({
        url: settings.url,
        transport: settings.transport,
        fetch: this.host.fetch ?? boundFetch,
        ...(apiKey ? { apiKey, headerName: settings.headerName } : {}),
      });
      const handshake = await client.connect();
      const tools = await client.listTools();
      if (keyed) {
        await this.host.credentials.activate({
          accountId,
          connectionId: connection.connectionId,
          packageId: MCP_PACKAGE_ID,
          generation,
        });
      }
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        {
          ...connection,
          state: "ready",
          failure: undefined,
          safeMetadata: {
            protocolVersion: handshake.protocolVersion,
            toolCount: tools.length,
            toolsHash: await mcpToolsHashV1(tools),
            ...(handshake.serverName
              ? { serverName: handshake.serverName }
              : {}),
          },
        },
      );
      return this.receipt(commandId, connection.connectionId);
    } catch (error) {
      const failure =
        error instanceof Error ? error.message : "MCP server handshake failed";
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        { ...connection, state: "failed", failure: failure.slice(0, 2_000) },
      );
      return {
        schemaVersion: 1,
        commandId,
        connectionId: connection.connectionId,
        status: "failed",
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  private receipt(
    commandId: string,
    connectionId: string,
  ): ConnectionCommandReceiptV1 {
    return {
      schemaVersion: 1,
      commandId,
      connectionId,
      status: "applied",
    };
  }

  private async requireConnection(
    accountId: string,
    connectionId: string,
  ): Promise<ConnectionView> {
    const connection = await this.host.settings.getConnection(
      accountId,
      connectionId,
    );
    if (!connection || connection.packageId !== MCP_PACKAGE_ID) {
      throw new Error("MCP Connection is unavailable");
    }
    return connection;
  }

  private async readCommand(
    commandId: string,
  ): Promise<StoredCommand | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${COMMAND_PREFIX}${commandId}`,
    );
    return stored === undefined ? undefined : decodeStoredCommand(stored);
  }

  /**
   * Receipts are retained under a bounded index: a User Durable Object cannot
   * grow an unbounded key space, and the oldest receipt is the one a client is
   * least likely to still be asking about.
   */
  private async recordCommand(command: StoredCommand): Promise<void> {
    const evicted = await this.host.storage.transaction(async (storage) => {
      const indexValue = await storage.get<unknown>(COMMAND_INDEX_KEY);
      const index = Array.isArray(indexValue)
        ? indexValue.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const next = [
        ...index.filter((value) => value !== command.commandId),
        command.commandId,
      ];
      const removed = next.splice(
        0,
        Math.max(0, next.length - MAX_STORED_COMMANDS),
      );
      await storage.put({
        [`${COMMAND_PREFIX}${command.commandId}`]: command,
        [COMMAND_INDEX_KEY]: next,
      });
      return removed;
    });
    // Eviction is a separate, idempotent step: the index no longer names these
    // receipts, so a failure here leaves unreachable keys, never a receipt the
    // index still promises.
    for (const commandId of evicted) {
      await this.host.storage.delete(`${COMMAND_PREFIX}${commandId}`);
    }
  }
}

export function createMcpUserBackendContribution(
  host: McpUserBackendHost,
): McpUserBackendContribution {
  return new McpUserBackendContribution(host);
}

export function createMcpUserBackendPlugin(
  host: McpUserBackendHost,
  lifecycle: { mount(value: McpUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createMcpUserBackendContribution(host));
}
