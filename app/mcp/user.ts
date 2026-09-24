// MCP servers in the User Durable Object: the Connection commands this
// Package owns, the token a server was added with, and each server's tool
// directory.
//
// Adding a server is a setting plus, at most, one secret, and the handshake
// that proves it is a read — `initialize` and `tools/list` do nothing at the
// server. So the add runs to its answer inside the command: the Connection is
// written `authorizing` with the token staged beside it, the server is asked,
// and the Connection settles `ready` with its directory or `failed` with the
// line a person reads. Nothing here is an effect worth an intent record; the
// command id still makes a replay answer what the first delivery did.
//
// The token never leaves this object except as a lease a Turn opens for one
// call, and the directory a Turn reads carries no part of it.
import { canonicalJson, sha256 } from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/core/connection";
import type { ConnectionView } from "@frockbot/core/configuration";
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";
import type {
  CredentialStorage,
  CredentialTransaction,
  CredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import {
  classifyMcpServerUrlV1,
  McpUnauthorizedError,
  withMcpSessionV1,
  type McpFetchV1,
  type McpServerInfoV1,
  type McpToolV1,
  type McpTransportV1,
} from "./client.js";
import {
  armMcpCatalogAlarmV1,
  boundMcpCatalogToolsV1,
  forgetMcpCatalogV1,
  listMcpCatalogJobsV1,
  McpCatalogTooLargeError,
  mcpCatalogJobKeyV1,
  publishMcpCatalogV1,
  readMcpCatalogV1,
  recordMcpCatalogFailureV1,
  type McpCatalogJobV1,
  type McpCatalogStorageV1,
  type McpCatalogTransactionV1,
} from "./catalog.js";
import {
  MCP_CONNECTION_TYPE_ID,
  MCP_PACKAGE_ID,
  MCP_URL_SETTING,
} from "./definition.js";

const COMMAND_PREFIX = "mcp:command:v1:";
/** How long a Turn's lease on a server's token lasts. One call's worth. */
const TOOL_LEASE_MS = 5 * 60_000;
/** How long an add may sit unanswered before a read calls it failed. */
const STALLED_ADD_MS = 2 * 60_000;
/** How long a Turn waits on a server with no directory yet. */
const FIRST_USE_MS = 5_000;
/** The most servers one User may hold. */
export const MCP_MAX_SERVERS_V1 = 16;

export const MCP_STALE_CONTRACT_MESSAGE_V1 =
  "stale-contract: This MCP server was removed or changed. Its tools are gone for this Turn.";
export const MCP_CATALOG_UNAVAILABLE_MESSAGE_V1 =
  "This MCP server's tools are unavailable for this Turn. Other tools still work.";

/** What a Connection of this Package keeps beside its state. Never a secret. */
export interface McpSafeMetadataV1 {
  /** The Bot-facing Tool Namespace: `mcp-<name>`, suffixed for a second. */
  namespace: string;
  /** The server's host, which audit rows and prompts name instead of its URL. */
  host: string;
  startedAt: string;
  transport?: McpTransportV1;
  serverName?: string;
  instructions?: string;
}

/** What a Turn reads of a server's directory. */
export type McpCatalogAnswerV1 =
  | { kind: "directory"; tools: { name: string; description: string }[] }
  | { kind: "tool"; tool: McpToolV1 }
  | { kind: "unavailable"; message: string }
  | { kind: "stale-contract"; message: string };

interface StoredCommand {
  accountId: string;
  fingerprint: string;
  connectionId: string;
  receipt?: ConnectionCommandReceiptV1;
}

type HostStorage = UserSettingsStorage &
  CredentialStorage & {
    delete(key: string): Promise<boolean>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number | Date): Promise<void>;
  };

export interface McpUserBackendHost {
  storage: HostStorage;
  settings: UserSettingsBackendContribution;
  credentials: Pick<
    CredentialUserBackendContribution,
    | "prepareApiKey"
    | "stagePreparedApiKey"
    | "activate"
    | "discardPending"
    | "lease"
    | "replayLease"
    | "openLease"
    | "settle"
    | "expireLeases"
    | "disconnect"
  >;
  /** The outbound seam; the guard is applied on top of it. */
  fetch?: McpFetchV1;
  now?: () => number;
  randomId?: () => string;
}

export function mcpSafeMetadataV1(
  connection: ConnectionView,
): McpSafeMetadataV1 | undefined {
  const meta = connection.safeMetadata;
  if (
    connection.packageId !== MCP_PACKAGE_ID ||
    typeof meta.namespace !== "string" ||
    typeof meta.host !== "string" ||
    typeof meta.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    namespace: meta.namespace,
    host: meta.host,
    startedAt: meta.startedAt,
    ...(meta.transport === "sse" || meta.transport === "streamable-http"
      ? { transport: meta.transport }
      : {}),
    ...(typeof meta.serverName === "string"
      ? { serverName: meta.serverName }
      : {}),
    ...(typeof meta.instructions === "string"
      ? { instructions: meta.instructions }
      : {}),
  };
}

/** The address a Connection of this Package reaches its server at. */
export function mcpServerUrlV1(connection: ConnectionView): string | undefined {
  const url = connection.settings?.[MCP_URL_SETTING];
  return typeof url === "string" ? url : undefined;
}

/**
 * The name a server's tools go under: the first telling label of its host —
 * `mcp.linear.app` is `mcp-linear` — so the model reads what the server is.
 */
export function mcpNamespaceBaseV1(host: string): string {
  const labels = host
    .replace(/:\d+$/, "")
    .toLowerCase()
    .split(".")
    .filter(Boolean);
  const generic = new Set(["www", "mcp", "api", "app", "server", "remote"]);
  const telling =
    labels.slice(0, -1).find((label) => !generic.has(label)) ??
    labels[0] ??
    "server";
  const slug = telling
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return `mcp-${slug || "server"}`;
}

/**
 * What a person reads when a server cannot be held. A server that wants a
 * sign-in is told apart from one that refused the token it was given: the
 * first needs a token, the second a new one.
 */
export function mcpFailureLineV1(error: unknown, withToken = false): string {
  if (error instanceof McpUnauthorizedError) {
    return withToken
      ? "The server refused this token. Remove the server and add it again with a new one."
      : "The server asks for a sign-in. Remove it and add it again with an access token from the server.";
  }
  if (error instanceof McpCatalogTooLargeError) return error.message;
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return "The server could not be reached.";
}

async function fingerprintOf(command: ConnectionCommandV1): Promise<string> {
  // The token is part of what makes a command the same command, and is
  // never stored: only its digest is.
  return sha256(canonicalJson(command));
}

export class McpUserBackendContribution {
  readonly packageId = MCP_PACKAGE_ID;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly host: McpUserBackendHost) {
    this.now = host.now ?? Date.now;
    this.randomId = host.randomId ?? (() => crypto.randomUUID());
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const key = `${COMMAND_PREFIX}${command.commandId}`;
    const fingerprint = await fingerprintOf(command);
    const stored = await this.host.storage.get<StoredCommand>(key);
    if (stored) {
      if (
        stored.accountId !== accountId ||
        stored.fingerprint !== fingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      if (stored.receipt) return stored.receipt;
      // A delivery that stopped after admitting its Connection: the
      // Connection is where the answer is.
      const connection = await this.host.settings.getConnection(
        accountId,
        stored.connectionId,
      );
      return this.receipt(
        command,
        stored.connectionId,
        connection?.state === "ready" || connection?.state === "disabled"
          ? "applied"
          : connection?.state === "authorizing"
            ? "reconciliation-required"
            : "failed",
      );
    }
    const receipt = await this.execute(accountId, command, key, fingerprint);
    await this.host.storage.put<StoredCommand>(key, {
      accountId,
      fingerprint,
      connectionId: receipt.connectionId,
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
    return Promise.reject(new Error("MCP servers hold no model credential"));
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The server's token for one tool call, as an expiring lease keyed by the
   * call's effect id. Only a ready server of this Package, at the generation
   * the Turn admitted, is leased; a server added with no token has nothing
   * to lease.
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
      packageId: MCP_PACKAGE_ID,
      effectId: input.effectId,
    });
    if (replay) return replay;
    return this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const connection = await this.host.settings.getConnection(
          input.accountId,
          input.connectionId,
          storage,
        );
        if (
          !connection ||
          connection.packageId !== MCP_PACKAGE_ID ||
          connection.state !== "ready" ||
          connection.generation !== input.connectionGeneration ||
          connection.authorization?.kind !== "api-key"
        ) {
          throw new Error("MCP server changed before its token was leased");
        }
        return this.host.credentials.lease(
          {
            accountId: input.accountId,
            connectionId: input.connectionId,
            packageId: MCP_PACKAGE_ID,
            effectId: input.effectId,
            expiresAt: new Date(this.now() + TOOL_LEASE_MS).toISOString(),
            expectedGeneration: input.connectionGeneration,
          },
          storage,
        );
      },
    );
  }

  async settleToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void> {
    await this.host.credentials.settle({
      ...input,
      packageId: MCP_PACKAGE_ID,
    });
  }

  /**
   * Runs before every settings read: an add that stopped before it answered
   * — the object evicted mid-handshake — is called failed rather than left
   * connecting forever.
   */
  async bootstrap(userId: string): Promise<void> {
    const snapshot = await this.host.settings.readSnapshot();
    for (const connection of snapshot.connections) {
      const metadata = mcpSafeMetadataV1(connection);
      if (
        connection.state !== "authorizing" ||
        !metadata ||
        this.now() - Date.parse(metadata.startedAt) < STALLED_ADD_MS
      ) {
        continue;
      }
      await this.fail(
        userId,
        connection,
        "Adding this server didn't finish. Remove it and add it again.",
      ).catch(() => undefined);
    }
  }

  /** `<namespace> → <host>` for every server this User holds, for audit. */
  async readHosts(): Promise<ReadonlyMap<string, string>> {
    const snapshot = await this.host.settings.readSnapshot();
    const hosts = new Map<string, string>();
    for (const connection of snapshot.connections) {
      const metadata = mcpSafeMetadataV1(connection);
      if (metadata) hosts.set(metadata.namespace, metadata.host);
    }
    return hosts;
  }

  /**
   * A server's directory for a Turn: every tool's name and description, or
   * one tool's schema when named. A server with no directory yet is listed
   * now, within the first-use bound.
   */
  async readToolCatalog(input: {
    userId: string;
    connectionId: string;
    generation: string;
    toolName?: string;
    firstUseMs?: number;
  }): Promise<McpCatalogAnswerV1> {
    const connection = await this.host.settings.getConnection(
      input.userId,
      input.connectionId,
    );
    const metadata = connection && mcpSafeMetadataV1(connection);
    if (
      !connection ||
      !metadata ||
      connection.state !== "ready" ||
      connection.generation !== input.generation
    ) {
      return { kind: "stale-contract", message: MCP_STALE_CONTRACT_MESSAGE_V1 };
    }
    let catalog = await readMcpCatalogV1(this.host.storage, input.connectionId);
    if (catalog?.generation !== input.generation) {
      await this.withinBound(
        this.refresh(input.userId, connection),
        input.firstUseMs ?? FIRST_USE_MS,
      );
      catalog = await readMcpCatalogV1(this.host.storage, input.connectionId);
      if (catalog?.generation !== input.generation) {
        return input.toolName === undefined
          ? { kind: "directory", tools: [] }
          : {
              kind: "unavailable",
              message: MCP_CATALOG_UNAVAILABLE_MESSAGE_V1,
            };
      }
    }
    if (input.toolName === undefined) {
      return {
        kind: "directory",
        tools: catalog.tools.map((tool) => ({
          name: tool.name,
          description: tool.description.slice(0, 240),
        })),
      };
    }
    const tool = catalog.tools.find(
      (candidate) => candidate.name === input.toolName,
    );
    return tool
      ? { kind: "tool", tool }
      : {
          kind: "unavailable",
          message: `This server has no tool named "${input.toolName.slice(0, 128)}". Search its tools with get_dynamic_tools({ "namespace": "${metadata.namespace}", "pattern": "<words in a tool name>" }).`,
        };
  }

  /** Runs one due directory refresh per firing, then re-arms for the next. */
  async alarm(): Promise<void> {
    const jobs = await listMcpCatalogJobsV1(this.catalogStorage());
    const due = jobs.find((job) => job.dueAt <= this.now());
    if (due) await this.refreshJob(due);
    const next = (await listMcpCatalogJobsV1(this.catalogStorage()))[0];
    if (next) {
      await armMcpCatalogAlarmV1(this.catalogStorage(), next.dueAt, this.now());
    }
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
    key: string,
    fingerprint: string,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (command.type) {
      case "connection/create":
      case "connection/create-api-key":
        return this.add(accountId, command, key, fingerprint);
      case "connection/update-label":
      case "connection/set-enabled":
      case "connection/disconnect":
      case "connection/refresh-models":
        return this.change(accountId, command);
      default:
        return this.receipt(
          command,
          "connectionId" in command ? command.connectionId : "none",
          "failed",
        );
    }
  }

  private async add(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      { type: "connection/create" | "connection/create-api-key" }
    >,
    key: string,
    fingerprint: string,
  ): Promise<ConnectionCommandReceiptV1> {
    if (
      command.packageId !== MCP_PACKAGE_ID ||
      command.connectionTypeId !== MCP_CONNECTION_TYPE_ID ||
      !(await this.host.settings.isPackageInstalled(accountId, MCP_PACKAGE_ID))
    ) {
      return this.receipt(command, "none", "failed");
    }
    const snapshot = await this.host.settings.readSnapshot();
    const servers = snapshot.connections.filter(
      (connection) =>
        connection.packageId === MCP_PACKAGE_ID &&
        connection.state !== "revoked",
    );
    const live = servers.filter((connection) => connection.state !== "failed");
    if (live.length >= MCP_MAX_SERVERS_V1) {
      throw new Error(
        `You can add up to ${MCP_MAX_SERVERS_V1} MCP servers. Remove one first.`,
      );
    }
    const classified = classifyMcpServerUrlV1(
      command.settings?.[MCP_URL_SETTING],
    );
    const token =
      command.type === "connection/create-api-key"
        ? command.apiKey.trim()
        : undefined;
    const connectionId = `connection-${this.randomId()}`;
    const generation = this.randomId();
    const host = "url" in classified ? classified.host : "";
    // A second server whose host reads the same gets the first free suffix;
    // a failed add holds no name.
    const taken = new Set(
      live.map((connection) => mcpSafeMetadataV1(connection)?.namespace),
    );
    const base = mcpNamespaceBaseV1(host || "server");
    let ordinal = 1;
    while (taken.has(ordinal === 1 ? base : `${base}-${ordinal}`)) ordinal += 1;
    const metadata: McpSafeMetadataV1 = {
      namespace: ordinal === 1 ? base : `${base}-${ordinal}`,
      host,
      startedAt: new Date(this.now()).toISOString(),
    };
    const connection: ConnectionView = {
      connectionId,
      packageId: MCP_PACKAGE_ID,
      connectionTypeId: MCP_CONNECTION_TYPE_ID,
      displayName: command.label.trim().slice(0, 120),
      state: "authorizing",
      generation,
      authorization: token
        ? {
            schemaVersion: 1,
            kind: "api-key",
            credential: {
              schemaVersion: 1,
              configured: true,
              source: "api-key",
              writable: true,
              generation,
              updatedAt: metadata.startedAt,
            },
          }
        : {
            schemaVersion: 1,
            kind: "none",
            credential: {
              schemaVersion: 1,
              configured: false,
              source: "none",
              writable: false,
            },
          },
      settings:
        "url" in classified ? { [MCP_URL_SETTING]: classified.url } : {},
      safeMetadata: { ...metadata },
    };
    const prepared = token
      ? await this.host.credentials.prepareApiKey({
          accountId,
          connectionId,
          packageId: MCP_PACKAGE_ID,
          generation,
          apiKey: token,
        })
      : undefined;
    await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        await this.host.settings.createConnection(
          accountId,
          connection,
          storage,
        );
        if (prepared) {
          await this.host.credentials.stagePreparedApiKey(prepared, storage);
        }
        await storage.put(key, {
          accountId,
          fingerprint,
          connectionId,
        } satisfies StoredCommand);
      },
    );
    // A retry of a server that would not hold is not a second server: the
    // earlier failed add of the same address, or of no usable address at
    // all, goes once this one is written.
    for (const sibling of servers) {
      const siblingUrl = mcpServerUrlV1(sibling);
      if (
        sibling.state === "failed" &&
        (siblingUrl === undefined ||
          ("url" in classified && siblingUrl === classified.url))
      ) {
        await this.retire(accountId, sibling).catch(() => undefined);
      }
    }
    if ("refusal" in classified) {
      await this.discard(connectionId, generation, prepared !== undefined);
      await this.fail(accountId, connection, classified.refusal);
      return this.receipt(command, connectionId, "failed");
    }
    let listed: { info: McpServerInfoV1; tools: McpToolV1[] };
    try {
      listed = await withMcpSessionV1(
        {
          url: classified.url,
          ...(token ? { token } : {}),
          ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
        },
        async (session) => ({
          info: session.info,
          tools: boundMcpCatalogToolsV1(await session.listTools()),
        }),
      );
    } catch (error) {
      await this.discard(connectionId, generation, prepared !== undefined);
      await this.fail(
        accountId,
        connection,
        mcpFailureLineV1(error, token !== undefined),
      );
      return this.receipt(command, connectionId, "failed");
    }
    const settled = await this.host.storage.transaction(
      async (storage: UserSettingsTransaction & CredentialTransaction) => {
        const current = await this.host.settings.getConnection(
          accountId,
          connectionId,
          storage,
        );
        // Removed while the server was being asked: nothing to settle.
        if (current?.state !== "authorizing") return false;
        if (prepared) {
          await this.host.credentials.activate(
            {
              accountId,
              connectionId,
              packageId: MCP_PACKAGE_ID,
              generation,
            },
            storage,
          );
        }
        await this.host.settings.replaceConnection(
          accountId,
          connectionId,
          generation,
          {
            ...current,
            state: "ready",
            safeMetadata: { ...metadata, ...this.serverMetadata(listed.info) },
          },
          storage,
        );
        return true;
      },
    );
    if (!settled) {
      await this.discard(connectionId, generation, prepared !== undefined);
      return this.receipt(command, connectionId, "failed");
    }
    await publishMcpCatalogV1(this.catalogStorage(), {
      connectionId,
      generation,
      tools: listed.tools,
      now: this.now(),
      readConnection: this.readConnection(accountId, connectionId),
    });
    return this.receipt(command, connectionId, "applied");
  }

  private serverMetadata(
    info: McpServerInfoV1,
  ): Pick<McpSafeMetadataV1, "transport" | "serverName" | "instructions"> {
    return {
      transport: info.transport,
      ...(info.serverName ? { serverName: info.serverName } : {}),
      ...(info.instructions ? { instructions: info.instructions } : {}),
    };
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
      !mcpSafeMetadataV1(connection) ||
      connection.state === "revoked"
    ) {
      return this.receipt(command, command.connectionId, "failed");
    }
    switch (command.type) {
      case "connection/update-label":
        await this.host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, displayName: command.label.trim() },
        );
        return this.receipt(command, connection.connectionId, "applied");
      case "connection/set-enabled":
        if (connection.state !== "ready" && connection.state !== "disabled") {
          return this.receipt(command, connection.connectionId, "failed");
        }
        await this.host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, state: command.enabled ? "ready" : "disabled" },
        );
        return this.receipt(command, connection.connectionId, "applied");
      case "connection/disconnect":
        await this.retire(accountId, connection);
        return this.receipt(command, connection.connectionId, "applied");
      case "connection/refresh-models": {
        if (connection.state !== "ready" && connection.state !== "disabled") {
          return this.receipt(command, connection.connectionId, "failed");
        }
        await this.refresh(accountId, connection);
        const after = await this.host.settings.getConnection(
          accountId,
          connection.connectionId,
        );
        const catalog = await readMcpCatalogV1(
          this.host.storage,
          connection.connectionId,
        );
        return this.receipt(
          command,
          connection.connectionId,
          (after?.state === "ready" || after?.state === "disabled") &&
            catalog !== undefined &&
            catalog.generation === connection.generation &&
            catalog.refreshError === undefined
            ? "applied"
            : "failed",
        );
      }
    }
  }

  /**
   * Removes a server: its token, its directory and its name. There is
   * nothing to revoke upstream — FrockBot was handed a token, not a grant.
   */
  private async retire(
    accountId: string,
    connection: ConnectionView,
  ): Promise<void> {
    await this.host.settings.replaceConnection(
      accountId,
      connection.connectionId,
      connection.generation,
      { ...connection, state: "revoked", failure: undefined } as ConnectionView,
    );
    await this.host.credentials.disconnect(connection.connectionId);
    await forgetMcpCatalogV1(this.host.storage, connection.connectionId);
  }

  private async discard(
    connectionId: string,
    generation: string,
    staged: boolean,
  ): Promise<void> {
    if (!staged) return;
    await this.host.credentials
      .discardPending(connectionId, generation)
      .catch(() => undefined);
  }

  /** Settles a server to `failed` with the line a person reads. */
  private async fail(
    accountId: string,
    connection: ConnectionView,
    failure: string,
  ): Promise<void> {
    const current = await this.host.settings.getConnection(
      accountId,
      connection.connectionId,
    );
    if (!current || current.state === "revoked" || current.state === "failed") {
      return;
    }
    await this.host.settings.replaceConnection(
      accountId,
      current.connectionId,
      current.generation,
      { ...current, state: "failed", failure },
    );
    await forgetMcpCatalogV1(this.host.storage, current.connectionId);
  }

  /**
   * Lists a server's tools again and stores them. Concurrent callers share
   * one listing. A server that refuses its token is failed — only a person
   * can hand it a new one — and one that is merely unreachable keeps the
   * tools it last listed and is retried on the alarm.
   */
  private refresh(userId: string, connection: ConnectionView): Promise<void> {
    const key = `${connection.connectionId}:${connection.generation}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const work = this.refreshJob(
      {
        schemaVersion: 1,
        connectionId: connection.connectionId,
        generation: connection.generation ?? "",
        dueAt: this.now(),
        attempts: 0,
      },
      userId,
    ).finally(() => {
      if (this.refreshing.get(key) === work) this.refreshing.delete(key);
    });
    this.refreshing.set(key, work);
    return work;
  }

  private async refreshJob(
    job: McpCatalogJobV1,
    knownUserId?: string,
  ): Promise<void> {
    const userId = knownUserId ?? (await this.catalogUserId());
    if (!userId) return;
    const connection = await this.host.settings.getConnection(
      userId,
      job.connectionId,
    );
    const url = connection && mcpServerUrlV1(connection);
    const metadata = connection && mcpSafeMetadataV1(connection);
    if (
      !connection ||
      !url ||
      !metadata ||
      (connection.state !== "ready" && connection.state !== "disabled") ||
      connection.generation !== job.generation
    ) {
      // A job for a server that is gone, or re-added, has nothing to do.
      await this.host.storage.delete(mcpCatalogJobKeyV1(job.connectionId));
      return;
    }
    let listed: { info: McpServerInfoV1; tools: McpToolV1[] };
    try {
      const token = await this.openToken(userId, connection);
      listed = await withMcpSessionV1(
        {
          url,
          ...(metadata.transport ? { transport: metadata.transport } : {}),
          ...(token ? { token } : {}),
          ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
        },
        async (session) => ({
          info: session.info,
          tools: await session.listTools(),
        }),
      );
    } catch (error) {
      if (error instanceof McpUnauthorizedError) {
        await this.fail(
          userId,
          connection,
          mcpFailureLineV1(error, connection.authorization?.kind === "api-key"),
        );
        return;
      }
      await recordMcpCatalogFailureV1(this.catalogStorage(), {
        job,
        message: mcpFailureLineV1(error),
        now: this.now(),
      });
      return;
    }
    const next = { ...metadata, ...this.serverMetadata(listed.info) };
    if (canonicalJson(next) !== canonicalJson(connection.safeMetadata)) {
      await this.host.settings
        .replaceConnection(
          userId,
          connection.connectionId,
          connection.generation,
          { ...connection, safeMetadata: { ...next } },
        )
        .catch(() => undefined);
    }
    try {
      await publishMcpCatalogV1(this.catalogStorage(), {
        connectionId: connection.connectionId,
        generation: job.generation,
        tools: listed.tools,
        now: this.now(),
        readConnection: this.readConnection(userId, connection.connectionId),
      });
    } catch (error) {
      await recordMcpCatalogFailureV1(this.catalogStorage(), {
        job,
        message: mcpFailureLineV1(error),
        now: this.now(),
      });
    }
  }

  /** Opens the server's token here, in the object that holds it. */
  private async openToken(
    userId: string,
    connection: ConnectionView,
  ): Promise<string | undefined> {
    if (
      connection.authorization?.kind !== "api-key" ||
      !connection.generation
    ) {
      return undefined;
    }
    const effectId = `mcp-list-${this.randomId()}`;
    const lease = await this.host.credentials.lease({
      accountId: userId,
      connectionId: connection.connectionId,
      packageId: MCP_PACKAGE_ID,
      effectId,
      expiresAt: new Date(this.now() + TOOL_LEASE_MS).toISOString(),
      expectedGeneration: connection.generation,
    });
    try {
      return await this.host.credentials.openLease({
        accountId: userId,
        packageId: MCP_PACKAGE_ID,
        lease,
      });
    } finally {
      await this.host.credentials
        .settle({
          accountId: userId,
          connectionId: connection.connectionId,
          packageId: MCP_PACKAGE_ID,
          effectId,
        })
        .catch(() => undefined);
    }
  }

  private async withinBound(work: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  private readConnection(userId: string, connectionId: string) {
    return (tx: McpCatalogTransactionV1) =>
      this.host.settings.getConnection(
        userId,
        connectionId,
        tx as unknown as UserSettingsTransaction,
      );
  }

  private catalogStorage(): McpCatalogStorageV1 {
    const storage = this.host.storage;
    return {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      list: (options) => storage.list(options),
      transaction: (callback) =>
        storage.transaction((tx) =>
          callback(tx as unknown as McpCatalogTransactionV1),
        ),
      ...(storage.getAlarm ? { getAlarm: () => storage.getAlarm!() } : {}),
      ...(storage.setAlarm
        ? { setAlarm: (time: number) => storage.setAlarm!(time) }
        : {}),
    };
  }

  private async catalogUserId(): Promise<string | undefined> {
    // The alarm has no caller. Settings pinned this object's User when the
    // account was provisioned.
    const stored = await this.host.storage.get<unknown>("user-id");
    return typeof stored === "string" ? stored : undefined;
  }
}

export function createMcpUserBackendContribution(
  host: McpUserBackendHost,
): McpUserBackendContribution {
  return new McpUserBackendContribution(host);
}

/** What an application hands this Contribution, under the Package's own key. */
export interface McpUserApplicationHostV1 {
  mcp: McpUserBackendHost;
}

export const userContribution = defineUserBackendContribution<
  McpUserApplicationHostV1,
  McpUserBackendContribution
>({
  specifier: "@frockbot/app/mcp/user",
  mount: (host, lifecycle) => {
    const contribution = createMcpUserBackendContribution(host.mcp);
    const unregister =
      host.mcp.settings.registerConfigurationReadBootstrap(contribution);
    const dispose = lifecycle.mount(contribution);
    return () => {
      unregister();
      dispose();
    };
  },
});
