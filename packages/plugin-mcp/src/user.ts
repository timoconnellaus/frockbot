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
  MAX_MCP_SERVERS_PER_USER_V1,
  MCP_CONNECTION_TYPE_ID,
  MCP_KEYED_CONNECTION_TYPE_ID,
  MCP_PACKAGE_ID,
  decodeMcpConnectionSettingsV1,
} from "./agent.js";
import {
  McpClient,
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_TOOLS_PER_SERVER,
  type McpFetch,
} from "./mcp-client.js";
import {
  decodeMcpLifecycleCommandV1,
  decodeMcpLifecycleReceiptV1,
  mcpFailureCodeV1,
  decodeMcpRefusalRecordV1,
  decodeMcpServerRecordV1,
  mcpConnectionMetadataV1,
  mcpRefusalKeyV1,
  mcpServerRecordKeyV1,
  MAX_MCP_REFUSALS_V1,
  MCP_REFUSAL_INDEX_KEY,
  MCP_SERVER_INDEX_KEY,
  type McpFailureCodeV1,
  type McpLifecycleCommandV1,
  type McpLifecycleReceiptV1,
  type McpRefusalRecordV1,
  type McpServerRecordV1,
  type McpServerStateV1,
  type McpServerStatusViewV1,
} from "./records.js";

/**
 * The global `fetch`, bound. A bare reference to it throws "Illegal
 * invocation" inside a Durable Object, where the built-in checks its
 * receiver.
 */
const boundFetch: McpFetch = (input, init) => fetch(input, init);

const COMMAND_PREFIX = "mcp-connection-command:";
const LIFECYCLE_COMMAND_PREFIX = "mcp-lifecycle-command:";
const LIFECYCLE_COMMAND_INDEX_KEY = "mcp-lifecycle-command-index";
const MAX_STORED_COMMANDS = 256;
const COMMAND_INDEX_KEY = "mcp-connection-command-index";
/** Long enough for one mount's handshake, short enough to be worth nothing. */
const TOOL_LEASE_MS = 5 * 60 * 1_000;

interface StoredLifecycleCommand {
  schemaVersion: 1;
  commandId: string;
  fingerprint: string;
  receipt: McpLifecycleReceiptV1;
}

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

function decodeStoredLifecycleCommand(input: unknown): StoredLifecycleCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored MCP lifecycle command is invalid");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "commandId",
    "fingerprint",
    "receipt",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.commandId !== "string" ||
    typeof value.fingerprint !== "string" ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("Stored MCP lifecycle command is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: value.commandId,
    fingerprint: value.fingerprint,
    receipt: decodeMcpLifecycleReceiptV1(value.receipt),
  };
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
   * The MCP lifecycle: add a server, set its instructions, restart it.
   *
   * These are the three GrokBot verbs the ordinary Connection commands do not
   * cover (`RenameMcpAccount` and `RemoveMcpAccount` are
   * `connection/update-label` and `connection/disconnect`, which need nothing
   * new). Each is idempotent on its `commandId`, and each refusal is durable:
   * a stdio server and a seventeenth server both leave a record saying why.
   */
  async executeLifecycle(
    accountId: string,
    input: unknown,
  ): Promise<McpLifecycleReceiptV1> {
    const command = decodeMcpLifecycleCommandV1(input);
    const commandFingerprint = await fingerprint(command);
    const stored = await this.readLifecycleCommand(command.commandId);
    if (stored) {
      if (stored.fingerprint !== commandFingerprint) {
        throw new Error(
          `MCP lifecycle command "${command.commandId}" was reused for a different command`,
        );
      }
      return stored.receipt;
    }
    const receipt = await this.applyLifecycle(accountId, command);
    await this.recordLifecycleCommand({
      schemaVersion: 1,
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      receipt,
    });
    return receipt;
  }

  /** GrokBot's `GetMcpServerStatus`, as a projection of the durable records. */
  async readServerStatus(accountId: string): Promise<McpServerStatusViewV1> {
    await this.host.settings.read(accountId);
    const servers: McpServerRecordV1[] = [];
    for (const serverId of await this.readServerIndex()) {
      const server = await this.readServer(serverId);
      if (server) servers.push(server);
    }
    const refusals: McpRefusalRecordV1[] = [];
    for (const refusalId of await this.readRefusalIndex()) {
      const value = await this.host.storage.get<unknown>(
        mcpRefusalKeyV1(refusalId),
      );
      if (value !== undefined) refusals.push(decodeMcpRefusalRecordV1(value));
    }
    return {
      schemaVersion: 1,
      servers: servers.sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
      refusals: refusals.toReversed(),
      quotas: {
        maxServers: MAX_MCP_SERVERS_PER_USER_V1,
        maxToolsPerServer: MAX_MCP_TOOLS_PER_SERVER,
        maxResponseBytes: MAX_MCP_RESPONSE_BYTES,
      },
    };
  }

  /**
   * What a Bot's mount of this server found. L2 dropped it on the floor: a
   * server that could not be reached simply contributed no tool and left no
   * trace. It is durable here, so an unreachable server is a visible `error`
   * on the User's own surface rather than a Bot that quietly lost its tools.
   *
   * A mount reporting an epoch the record has moved past is ignored: the
   * outcome describes a server generation the User has already restarted away
   * from.
   */
  async recordMountOutcome(input: {
    accountId: string;
    connectionId: string;
    serverEpoch?: number;
    state: "ready" | "needs-auth" | "error";
    failure?: { code: McpFailureCodeV1; message: string };
    protocolVersion?: string;
    toolCount?: number;
    toolsHash?: string;
  }): Promise<void> {
    const current = await this.readServer(input.connectionId);
    if (!current) return;
    if (
      input.serverEpoch !== undefined &&
      input.serverEpoch !== current.serverEpoch
    ) {
      return;
    }
    const at = new Date(this.now()).toISOString();
    await this.writeServer({
      ...current,
      state: input.state,
      ...(input.protocolVersion === undefined
        ? {}
        : { protocolVersion: input.protocolVersion }),
      toolCount:
        input.toolCount ?? (input.state === "ready" ? current.toolCount : 0),
      toolsHash: input.toolsHash ?? current.toolsHash,
      lastHandshakeAt: at,
      ...(input.failure
        ? {
            failure: {
              code: input.failure.code,
              message: input.failure.message.slice(0, 2_000),
              at,
            },
          }
        : {}),
    });
  }

  private async applyLifecycle(
    accountId: string,
    command: McpLifecycleCommandV1,
  ): Promise<McpLifecycleReceiptV1> {
    switch (command.type) {
      case "mcp/add-server":
        return this.addServer(accountId, command);
      case "mcp/set-instructions": {
        const server = await this.requireServer(accountId, command.serverId);
        await this.writeServer({
          ...server,
          ...(command.instructions
            ? { instructions: command.instructions }
            : { instructions: undefined }),
        });
        await this.mirrorConnectionMetadata(accountId, command.serverId);
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          serverId: command.serverId,
        };
      }
      case "mcp/restart": {
        const server = await this.requireServer(accountId, command.serverId);
        const connection = await this.requireConnection(
          accountId,
          command.serverId,
        );
        if (connection.state === "revoked" || connection.state === "revoking") {
          throw new Error("MCP Connection is revoked");
        }
        // The epoch bump is the whole of restart: it is in the Assignment's
        // resolution key, so the next admitted Turn resolves a different
        // mount and re-handshakes, while the in-flight Turn keeps the client
        // it already holds. The handshake here refreshes the status the User
        // is looking at; it kills no process, because there is none.
        const receipt = await this.validateAndActivate(
          accountId,
          command.commandId,
          connection,
          connection.connectionTypeId === MCP_KEYED_CONNECTION_TYPE_ID,
          {
            serverEpoch: server.serverEpoch + 1,
            ...(server.instructions
              ? { instructions: server.instructions }
              : {}),
          },
        );
        const next = await this.readServer(command.serverId);
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          status: receipt.status === "applied" ? "applied" : "failed",
          serverId: command.serverId,
          ...(next?.failure
            ? { code: next.failure.code, failure: next.failure.message }
            : {}),
        };
      }
    }
  }

  /**
   * A custom remote MCP server by URL. stdio is refused durably: it needs a
   * bidirectional pipe on the User's Computer that the Computer interface
   * does not offer yet, and a refusal a User can read is a smaller lie than a
   * Connection that never connects.
   */
  private async addServer(
    accountId: string,
    command: Extract<McpLifecycleCommandV1, { type: "mcp/add-server" }>,
  ): Promise<McpLifecycleReceiptV1> {
    if (command.transport === "stdio") {
      return this.refuse(command, {
        code: "unsupported-transport",
        message:
          "A stdio MCP server runs on the User's Computer, which needs a bidirectional service pipe FrockBot's Computer interface does not offer yet. Add the server over streamable-http or sse instead.",
      });
    }
    const servers = await this.readServerIndex();
    if (servers.length >= MAX_MCP_SERVERS_PER_USER_V1) {
      return this.refuse(command, {
        code: "server-quota",
        message: `A User may hold at most ${MAX_MCP_SERVERS_PER_USER_V1} MCP servers; this one holds ${servers.length}.`,
      });
    }
    const settings = {
      url: command.url,
      transport: command.transport,
      ...(command.headerName ? { "header-name": command.headerName } : {}),
    };
    const receipt = await this.create(
      accountId,
      command.apiKey === undefined
        ? {
            schemaVersion: 1,
            type: "connection/create",
            commandId: command.commandId,
            packageId: MCP_PACKAGE_ID,
            connectionTypeId: MCP_CONNECTION_TYPE_ID,
            label: command.label,
            settings,
          }
        : {
            schemaVersion: 1,
            type: "connection/create-api-key",
            commandId: command.commandId,
            packageId: MCP_PACKAGE_ID,
            connectionTypeId: MCP_KEYED_CONNECTION_TYPE_ID,
            label: command.label,
            apiKey: command.apiKey,
            settings,
          },
      command.instructions === undefined
        ? {}
        : { instructions: command.instructions },
    );
    const server = await this.readServer(receipt.connectionId);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: receipt.status === "applied" ? "applied" : "failed",
      serverId: receipt.connectionId,
      ...(server?.failure
        ? { code: server.failure.code, failure: server.failure.message }
        : {}),
    };
  }

  private async refuse(
    command: McpLifecycleCommandV1,
    failure: { code: McpFailureCodeV1; message: string },
  ): Promise<McpLifecycleReceiptV1> {
    const refusal: McpRefusalRecordV1 = {
      schemaVersion: 1,
      refusalId: this.randomId(),
      commandId: command.commandId,
      code: failure.code,
      message: failure.message,
      at: new Date(this.now()).toISOString(),
      ...(command.type === "mcp/add-server"
        ? {
            label: command.label,
            url: command.url,
            transport: command.transport,
          }
        : {}),
    };
    await this.recordRefusal(refusal);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "refused",
      code: failure.code,
      failure: failure.message,
    };
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
        // A rename is GrokBot's `RenameMcpAccount`, and it renames the tools
        // too: the server slug is derived from the label, so the record must
        // carry the new one or the status would disagree with the tool names.
        const renamed = await this.readServer(connection.connectionId);
        if (renamed) {
          await this.writeServer({ ...renamed, label: command.label });
        }
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
        // GrokBot's `RemoveMcpAccount`: the server is gone, so its record is
        // gone with it. The Assignments that named it become unavailable
        // tombstones through the ordinary Connection dependency path.
        await this.removeServer(connection.connectionId);
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
    options: { instructions?: string } = {},
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
      options,
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
   * The handshake that decides a Connection's state, and with it the durable
   * server record.
   *
   * Success activates the credential generation and records what the server
   * said about itself; failure leaves a `failed` Connection and a server
   * record in `needs-auth` or `error` carrying the reason. Both are durable:
   * the record is the only place a User can read why a server they added is
   * offering nothing.
   */
  private async validateAndActivate(
    accountId: string,
    commandId: string,
    connection: ConnectionView,
    keyed: boolean,
    options: { serverEpoch?: number; instructions?: string } = {},
  ): Promise<ConnectionCommandReceiptV1> {
    const generation = connection.generation!;
    const existing = await this.readServer(connection.connectionId);
    const serverEpoch = options.serverEpoch ?? existing?.serverEpoch ?? 1;
    const instructions = options.instructions ?? existing?.instructions;
    let settings: ReturnType<typeof decodeMcpConnectionSettingsV1> | undefined;
    let client: McpClient | undefined;
    try {
      settings = decodeMcpConnectionSettingsV1(connection.settings);
      // Durable intent before the request leaves: a handshake that never
      // returns leaves a record saying so, not silence.
      await this.writeServer({
        schemaVersion: 1,
        serverId: connection.connectionId,
        label: connection.displayName,
        url: settings.url.toString(),
        transport: settings.transport,
        ...(instructions ? { instructions } : {}),
        serverEpoch,
        state: "connecting",
        toolCount: existing?.toolCount ?? 0,
        toolsHash: existing?.toolsHash ?? "",
        lastHandshakeAt: new Date(this.now()).toISOString(),
      });
      const apiKey = keyed
        ? await this.openConnectionCredential(accountId, connection, generation)
        : undefined;
      client = new McpClient({
        url: settings.url,
        transport: settings.transport,
        fetch: this.host.fetch ?? boundFetch,
        ...(apiKey ? { apiKey, headerName: settings.headerName } : {}),
        maxResponseBytes: MAX_MCP_RESPONSE_BYTES,
        maxTools: MAX_MCP_TOOLS_PER_SERVER,
      });
      const handshake = await client.connect();
      const tools = await client.listTools();
      if (keyed && connection.state === "authorizing") {
        await this.host.credentials.activate({
          accountId,
          connectionId: connection.connectionId,
          packageId: MCP_PACKAGE_ID,
          generation,
        });
      }
      const server = await this.writeServer({
        schemaVersion: 1,
        serverId: connection.connectionId,
        label: connection.displayName,
        url: settings.url.toString(),
        transport: settings.transport,
        ...(instructions ? { instructions } : {}),
        serverEpoch,
        state: "ready",
        protocolVersion: handshake.protocolVersion,
        toolCount: tools.length,
        toolsHash: await mcpToolsHashV1(tools),
        lastHandshakeAt: new Date(this.now()).toISOString(),
      });
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        {
          ...connection,
          state: "ready",
          failure: undefined,
          safeMetadata: {
            ...mcpConnectionMetadataV1(server),
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
      const code = mcpFailureCodeV1(error);
      const server = await this.writeServer({
        schemaVersion: 1,
        serverId: connection.connectionId,
        label: connection.displayName,
        url: settings
          ? settings.url.toString()
          : String(connection.settings?.url ?? "about:invalid"),
        transport: settings?.transport ?? "streamable-http",
        ...(instructions ? { instructions } : {}),
        serverEpoch,
        state: code === "unauthorized" ? "needs-auth" : "error",
        toolCount: 0,
        toolsHash: existing?.toolsHash ?? "",
        lastHandshakeAt: new Date(this.now()).toISOString(),
        failure: {
          code,
          message: failure.slice(0, 2_000),
          at: new Date(this.now()).toISOString(),
        },
      }).catch(() => undefined);
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        {
          ...connection,
          state: "failed",
          failure: failure.slice(0, 2_000),
          ...(server ? { safeMetadata: mcpConnectionMetadataV1(server) } : {}),
        },
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

  /**
   * The plaintext of a keyed server's credential, for a handshake this object
   * performs itself. It travels the same lease the Bot's host would open: an
   * effect id, an expiry, and a settle the moment the key is in hand, so a
   * restart leaves nothing open behind it.
   */
  private async openConnectionCredential(
    accountId: string,
    connection: ConnectionView,
    generation: string,
  ): Promise<string> {
    if (connection.state === "authorizing") {
      return this.host.credentials.readStagedApiKey({
        accountId,
        connectionId: connection.connectionId,
        packageId: MCP_PACKAGE_ID,
        generation,
      });
    }
    const effectId = `mcp-handshake:${connection.connectionId}:${this.randomId()}`;
    const lease = await this.host.credentials.lease({
      accountId,
      connectionId: connection.connectionId,
      packageId: MCP_PACKAGE_ID,
      effectId,
      expiresAt: new Date(this.now() + TOOL_LEASE_MS).toISOString(),
      expectedGeneration: generation,
    });
    try {
      return await this.host.credentials.openLease({
        accountId,
        packageId: MCP_PACKAGE_ID,
        lease,
      });
    } finally {
      await this.host.credentials
        .settle({
          accountId,
          connectionId: connection.connectionId,
          packageId: MCP_PACKAGE_ID,
          effectId,
        })
        .catch(() => undefined);
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

  private async requireServer(
    accountId: string,
    serverId: string,
  ): Promise<McpServerRecordV1> {
    await this.requireConnection(accountId, serverId);
    const server = await this.readServer(serverId);
    if (!server) throw new Error("MCP server record is unavailable");
    return server;
  }

  private async readServer(
    serverId: string,
  ): Promise<McpServerRecordV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(
      mcpServerRecordKeyV1(serverId),
    );
    return stored === undefined ? undefined : decodeMcpServerRecordV1(stored);
  }

  /**
   * One record write, index included. The record decodes on the way out as
   * well as on the way in, so a field this build would refuse to read is
   * never written in the first place.
   */
  private async writeServer(
    server: McpServerRecordV1,
  ): Promise<McpServerRecordV1> {
    const decoded = decodeMcpServerRecordV1(server);
    await this.host.storage.transaction(async (storage) => {
      const index = await this.readServerIndex(storage);
      await storage.put({
        [mcpServerRecordKeyV1(decoded.serverId)]: decoded,
        [MCP_SERVER_INDEX_KEY]: index.includes(decoded.serverId)
          ? index
          : [...index, decoded.serverId],
      });
    });
    return decoded;
  }

  private async removeServer(serverId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const index = await this.readServerIndex(storage);
      await storage.put(
        MCP_SERVER_INDEX_KEY,
        index.filter((value) => value !== serverId),
      );
    });
    await this.host.storage.delete(mcpServerRecordKeyV1(serverId));
  }

  private async readServerIndex(
    storage: { get<T>(key: string): Promise<T | undefined> } = this.host
      .storage,
  ): Promise<string[]> {
    const stored = await storage.get<unknown>(MCP_SERVER_INDEX_KEY);
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  }

  private async readRefusalIndex(
    storage: { get<T>(key: string): Promise<T | undefined> } = this.host
      .storage,
  ): Promise<string[]> {
    const stored = await storage.get<unknown>(MCP_REFUSAL_INDEX_KEY);
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  }

  /** The refusal ledger, bounded: the oldest refusal is the first to go. */
  private async recordRefusal(refusal: McpRefusalRecordV1): Promise<void> {
    const evicted = await this.host.storage.transaction(async (storage) => {
      const index = await this.readRefusalIndex(storage);
      const next = [...index, refusal.refusalId];
      const removed = next.splice(
        0,
        Math.max(0, next.length - MAX_MCP_REFUSALS_V1),
      );
      await storage.put({
        [mcpRefusalKeyV1(refusal.refusalId)]: decodeMcpRefusalRecordV1(refusal),
        [MCP_REFUSAL_INDEX_KEY]: next,
      });
      return removed;
    });
    for (const refusalId of evicted) {
      await this.host.storage.delete(mcpRefusalKeyV1(refusalId));
    }
  }

  /**
   * Re-project the record onto the Connection's `safeMetadata`, which is the
   * seam the Bot Durable Object already reads. The record stays the
   * authority; this is how the epoch and the instructions reach a mount
   * without a second cross-object call at Turn time.
   */
  private async mirrorConnectionMetadata(
    accountId: string,
    serverId: string,
  ): Promise<void> {
    const server = await this.readServer(serverId);
    const connection = await this.requireConnection(accountId, serverId);
    if (!server) return;
    await this.host.settings.replaceConnection(
      accountId,
      connection.connectionId,
      connection.generation,
      {
        ...connection,
        // Rebuilt, not merged: clearing the instructions must remove the
        // key, and a spread of `undefined` would leave it present.
        safeMetadata: {
          ...(typeof connection.safeMetadata.serverName === "string"
            ? { serverName: connection.safeMetadata.serverName }
            : {}),
          ...mcpConnectionMetadataV1(server),
        },
      },
    );
  }

  private async readLifecycleCommand(
    commandId: string,
  ): Promise<StoredLifecycleCommand | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${LIFECYCLE_COMMAND_PREFIX}${commandId}`,
    );
    return stored === undefined
      ? undefined
      : decodeStoredLifecycleCommand(stored);
  }

  private async recordLifecycleCommand(
    command: StoredLifecycleCommand,
  ): Promise<void> {
    const evicted = await this.host.storage.transaction(async (storage) => {
      const indexValue = await storage.get<unknown>(
        LIFECYCLE_COMMAND_INDEX_KEY,
      );
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
        [`${LIFECYCLE_COMMAND_PREFIX}${command.commandId}`]: command,
        [LIFECYCLE_COMMAND_INDEX_KEY]: next,
      });
      return removed;
    });
    for (const commandId of evicted) {
      await this.host.storage.delete(`${LIFECYCLE_COMMAND_PREFIX}${commandId}`);
    }
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
