// MCP servers in the User Durable Object: the Connection commands this
// Package owns, the credential a server holds — a token the person gave it,
// or the access token a sign-in got it — and each server's tool directory.
//
// Adding a server is a setting plus, at most, one secret, and the handshake
// that proves it is a read — `initialize` and `tools/list` do nothing at the
// server. So the add runs to its answer inside the command: the Connection is
// written `authorizing` with the token staged beside it, the server is asked,
// and the Connection settles `ready` with its directory or `failed` with the
// line a person reads. Nothing here is an effect worth an intent record; the
// command id still makes a replay answer what the first delivery did.
//
// Signing in is the exception, because an authorization code and a rotating
// refresh token are each good once. A sign-in is started here and kept here
// — the PKCE verifier and the client identity sealed, the signed state's
// digest beside them — and the callback claims it before the code is traded,
// so a second callback finds it taken and never trades again. A refresh
// records its intent through the credential store before it is sent, and one
// that stopped partway asks the person to sign in again rather than guess.
//
// No credential leaves this object except as a lease a Turn opens for one
// call, and that lease is only ever the access token: the refresh token and
// the client identity stay sealed in records a lease cannot name.
import { canonicalJson, sha256 } from "@frockbot/core/contracts";
import type {
  ConnectionAuthorizationViewV1,
  CredentialLeaseV1,
} from "@frockbot/core/connection";
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
  type McpAuthChallengeV1,
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
import {
  forgetMcpGrantV1,
  forgetMcpSignInV1,
  markMcpSignInExchangingV1,
  openMcpSignInV1,
  readMcpGrantV1,
  readMcpSignInV1,
  sealMcpGrantV1,
  writeMcpSignInV1,
} from "./grant.js";
import {
  authorizeMcpSignInV1,
  decodeMcpAccessSecretV1,
  discoverMcpSignInV1,
  encodeMcpAccessSecretV1,
  exchangeMcpSignInV1,
  MCP_SIGN_IN_TTL_MS_V1,
  mcpOAuthReturnClientV1,
  McpSignInError,
  refreshMcpSignInV1,
  registerMcpClientV1,
  revokeMcpSignInV1,
  type McpSignInGrantV1,
  type McpSignInTokensV1,
} from "./oauth.js";
import { signMcpOAuthStateV1 } from "./oauth-state.js";

const COMMAND_PREFIX = "mcp:command:v1:";
/** How long a Turn's lease on a server's token lasts. One call's worth. */
const TOOL_LEASE_MS = 5 * 60_000;
/**
 * An access token that would expire inside a lease is refreshed before it is
 * leased, so a Turn never holds one that dies mid-call.
 */
const REFRESH_BEFORE_EXPIRY_MS = TOOL_LEASE_MS;
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

/** A server whose authorization server FrockBot can sign in with. */
export const MCP_SIGN_IN_LINE_V1 = "This server asks you to sign in.";
export const MCP_SIGN_IN_AGAIN_LINE_V1 =
  "Your sign-in to this server has ended. Sign in again.";
const TOKEN_LINE = "This server asks for an access token.";
const REFUSED_TOKEN_LINE = "The server refused this token. Give it a new one.";
const LOST_TOKEN_LINE = "Give this server its access token again.";

/** How a server holds its credential, as its Connection says. */
type McpCredentialKindV1 = "none" | "api-key" | "grant";

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

type HostTransaction = UserSettingsTransaction & CredentialTransaction;

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
    | "openPreparedSecret"
    | "refreshActiveSecret"
  >;
  /**
   * The credential keyring, which a sign-in's state is signed under. Absent,
   * no server can be signed in to; a token still works.
   */
  keyring?: string;
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
 * What a person reads when a server cannot be held. A refused credential is
 * told by how the server holds one: a server that holds none needs a token or
 * a sign-in, one with a token needs a new token, and a signed-in one needs
 * signing in again.
 */
export function mcpFailureLineV1(
  error: unknown,
  credential: McpCredentialKindV1 = "none",
): string {
  if (error instanceof McpUnauthorizedError) {
    return credential === "api-key"
      ? REFUSED_TOKEN_LINE
      : credential === "grant"
        ? MCP_SIGN_IN_AGAIN_LINE_V1
        : TOKEN_LINE;
  }
  if (error instanceof McpSignInError) return error.message;
  if (error instanceof McpCatalogTooLargeError) return error.message;
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return "The server could not be reached.";
}

function credentialKindOf(connection: ConnectionView): McpCredentialKindV1 {
  const kind = connection.authorization?.kind;
  return kind === "api-key" || kind === "grant" ? kind : "none";
}

function authorizationOf(
  kind: McpCredentialKindV1,
  generation: string | undefined,
  updatedAt: string,
): ConnectionAuthorizationViewV1 {
  return generation === undefined
    ? {
        schemaVersion: 1,
        kind,
        credential: {
          schemaVersion: 1,
          configured: false,
          source: kind,
          writable: kind !== "none",
        },
      }
    : {
        schemaVersion: 1,
        kind,
        credential: {
          schemaVersion: 1,
          configured: true,
          source: kind,
          writable: true,
          generation,
          updatedAt,
        },
      };
}

/** A Connection with no failure line, rather than one set to `undefined`. */
function withoutFailure(connection: ConnectionView): ConnectionView {
  const { failure: _failure, ...rest } = connection;
  return rest;
}

async function fingerprintOf(command: ConnectionCommandV1): Promise<string> {
  // The token is part of what makes a command the same command, and is
  // never stored: only its digest is.
  return sha256(canonicalJson(command));
}

type McpOAuthCommandV1 = Extract<
  ConnectionCommandV1,
  { type: "connection/oauth" }
>;

/** A credential about to be installed on a server, and how it is held. */
type NewCredential =
  | { kind: "api-key"; token: string }
  | {
      kind: "grant";
      tokens: McpSignInTokensV1;
      grant: Omit<McpSignInGrantV1, "accessToken" | "refreshToken">;
    };

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
   * The server's credential for one tool call, as an expiring lease keyed by
   * the call's effect id. Only a ready server of this Package, at the
   * generation the Turn admitted, is leased; a server with no credential has
   * nothing to lease. A signed-in server's access token is refreshed first
   * when it would expire inside the lease.
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
    const before = await this.host.settings.getConnection(
      input.accountId,
      input.connectionId,
    );
    if (
      before?.generation === input.connectionGeneration &&
      credentialKindOf(before) === "grant"
    ) {
      await this.freshen(input.accountId, before);
    }
    return this.host.storage.transaction(async (storage: HostTransaction) => {
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
        credentialKindOf(connection) === "none"
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
    });
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
      case "connection/oauth":
        return command.action === "start"
          ? this.startSignIn(accountId, command)
          : command.action === "complete"
            ? this.completeSignIn(accountId, command)
            : this.receipt(command, command.connectionId ?? "none", "failed");
      case "connection/rotate-api-key": {
        const token = command.apiKey.trim();
        const installed =
          token.length > 0 &&
          (await this.install(accountId, command.connectionId, {
            kind: "api-key",
            token,
          }));
        return this.receipt(
          command,
          command.connectionId,
          installed ? "applied" : "failed",
        );
      }
      case "connection/update-label":
      case "connection/set-enabled":
      case "connection/disconnect":
      case "connection/refresh-models":
        return this.change(accountId, command);
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
        ? authorizationOf("api-key", generation, metadata.startedAt)
        : authorizationOf("none", undefined, metadata.startedAt),
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
    await this.host.storage.transaction(async (storage: HostTransaction) => {
      await this.host.settings.createConnection(accountId, connection, storage);
      if (prepared) {
        await this.host.credentials.stagePreparedApiKey(prepared, storage);
      }
      await storage.put(key, {
        accountId,
        fingerprint,
        connectionId,
      } satisfies StoredCommand);
    });
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
      await this.failWith(
        accountId,
        connection,
        error,
        token ? "api-key" : "none",
      );
      return this.receipt(command, connectionId, "failed");
    }
    const settled = await this.host.storage.transaction(
      async (storage: HostTransaction) => {
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

  /**
   * Starts a sign-in to a server the person already added: finds where its
   * sign-in happens, gets FrockBot an identity there — the one kept from an
   * earlier sign-in to the same authorization server, when there is one —
   * and answers the address to open. The state in that address is signed
   * for this User, this server and this attempt; what the callback trades
   * the code with stays sealed here.
   */
  private async startSignIn(
    accountId: string,
    command: McpOAuthCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    const connectionId = command.connectionId ?? "none";
    const refused = (message: string): ConnectionCommandReceiptV1 => ({
      ...this.receipt(command, connectionId, "failed"),
      oauth: { attemptId: command.attemptId, status: "failed", message },
    });
    const connection = command.connectionId
      ? await this.host.settings.getConnection(accountId, command.connectionId)
      : undefined;
    const url = connection && mcpServerUrlV1(connection);
    // The gateway names the return page; only one of this Package's own is
    // one a sign-in may come back to.
    const callback = command.callbackUrl
      ? URL.parse(command.callbackUrl)
      : null;
    if (
      !connection ||
      !mcpSafeMetadataV1(connection) ||
      connection.state === "revoked" ||
      connection.state === "authorizing" ||
      !url ||
      !this.host.keyring ||
      !callback ||
      callback.search ||
      callback.hash ||
      mcpOAuthReturnClientV1(callback.pathname) === null
    ) {
      return refused("This server can't be signed in to right now.");
    }
    try {
      const server = await discoverMcpSignInV1({
        url,
        challenge: await this.challenge(url),
        ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
      });
      const kept = await readMcpGrantV1(
        this.host.storage,
        this.host.credentials,
        { accountId, connectionId: connection.connectionId },
      ).catch(() => undefined);
      const client =
        kept?.server.authorizationServerUrl === server.authorizationServerUrl
          ? kept.client
          : await registerMcpClientV1({
              server,
              origin: callback.origin,
              ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
            });
      const expiresAt = this.now() + MCP_SIGN_IN_TTL_MS_V1;
      const state = await signMcpOAuthStateV1(this.host.keyring, {
        userId: accountId,
        connectionId: connection.connectionId,
        attemptId: command.attemptId,
        expiresAt,
      });
      const redirectUri = `${callback.origin}${callback.pathname}`;
      const started = await authorizeMcpSignInV1({
        server,
        client,
        redirectUri,
        state,
      });
      // A new sign-in replaces one still in the browser: that one's state
      // no longer matches anything kept, so its callback changes nothing.
      await writeMcpSignInV1(this.host.storage, this.host.credentials, {
        accountId,
        connectionId: connection.connectionId,
        attemptId: command.attemptId,
        expiresAt,
        redirectUri,
        stateDigest: await sha256(state),
        secret: { server, client, codeVerifier: started.codeVerifier },
      });
      return {
        ...this.receipt(command, connection.connectionId, "applied"),
        oauth: {
          attemptId: command.attemptId,
          status: "waiting",
          authorizationUrl: started.authorizationUrl,
          expiresAt,
        },
      };
    } catch (error) {
      const line =
        error instanceof McpSignInError
          ? error.message
          : "This server's sign-in couldn't be started. Try again later.";
      await this.noteSignInFailure(accountId, connection.connectionId, line);
      return refused(line);
    }
  }

  /**
   * The person is back from the server's sign-in. The callback's state was
   * verified before this object was addressed; here it must also be the
   * state this object minted for this attempt, and the attempt is claimed
   * before the code is traded, so the code is traded once whatever arrives.
   */
  private async completeSignIn(
    accountId: string,
    command: McpOAuthCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    const connectionId = command.connectionId ?? "none";
    const answer = (
      status: "ready" | "failed",
      message?: string,
    ): ConnectionCommandReceiptV1 => ({
      ...this.receipt(
        command,
        connectionId,
        status === "ready" ? "applied" : "failed",
      ),
      oauth: {
        attemptId: command.attemptId,
        status,
        ...(message ? { message } : {}),
      },
    });
    const callback = command.code ? URL.parse(command.code) : null;
    const state = callback?.searchParams.get("state");
    const signIn = await readMcpSignInV1(this.host.storage, connectionId);
    if (
      !callback ||
      !state ||
      !signIn ||
      signIn.accountId !== accountId ||
      signIn.attemptId !== command.attemptId ||
      signIn.stateDigest !== (await sha256(state))
    ) {
      return answer(
        "failed",
        "This sign-in is no longer the one FrockBot is waiting for.",
      );
    }
    if (signIn.status !== "waiting") {
      return answer("failed", "This sign-in already came back.");
    }
    if (signIn.expiresAt <= this.now()) {
      await forgetMcpSignInV1(this.host.storage, connectionId);
      const line = "The sign-in took too long. Sign in again.";
      await this.noteSignInFailure(accountId, connectionId, line);
      return answer("failed", line);
    }
    const claimed = await this.host.storage.transaction(
      async (storage: HostTransaction) => {
        const current = await readMcpSignInV1(storage, connectionId);
        if (
          current?.attemptId !== signIn.attemptId ||
          current.status !== "waiting"
        ) {
          return false;
        }
        await markMcpSignInExchangingV1(storage, current);
        return true;
      },
    );
    if (!claimed) return answer("failed", "This sign-in already came back.");
    try {
      const secret = await openMcpSignInV1(this.host.credentials, signIn);
      const refusal = callback.searchParams.get("error");
      const code = callback.searchParams.get("code");
      if (refusal || !code) {
        throw new McpSignInError(
          refusal === "access_denied"
            ? "The sign-in was cancelled."
            : `The server refused the sign-in (${(refusal ?? "no code").slice(0, 64)}). Sign in again.`,
        );
      }
      const tokens = await exchangeMcpSignInV1({
        server: secret.server,
        client: secret.client,
        code,
        ...(callback.searchParams.has("iss")
          ? { iss: callback.searchParams.get("iss")! }
          : {}),
        codeVerifier: secret.codeVerifier,
        redirectUri: signIn.redirectUri,
        ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
        now: this.now(),
      });
      const installed = await this.install(accountId, connectionId, {
        kind: "grant",
        tokens,
        grant: { server: secret.server, client: secret.client },
      });
      return installed
        ? answer("ready")
        : answer("failed", "Signed in, but the server still refused FrockBot.");
    } catch (error) {
      const line =
        error instanceof McpSignInError
          ? error.message
          : "The sign-in couldn't finish. Sign in again.";
      await this.noteSignInFailure(accountId, connectionId, line);
      return answer("failed", line);
    } finally {
      await forgetMcpSignInV1(this.host.storage, connectionId);
    }
  }

  /**
   * Puts a new credential on a server — a token the person gave it, or the
   * access token a sign-in got — once the server has taken it: the handshake
   * runs with it first, and only then does the Connection move to a new
   * generation holding it. A server that refuses it keeps what it had.
   */
  private async install(
    accountId: string,
    connectionId: string,
    credential: NewCredential,
  ): Promise<boolean> {
    const connection = await this.host.settings.getConnection(
      accountId,
      connectionId,
    );
    const url = connection && mcpServerUrlV1(connection);
    const metadata = connection && mcpSafeMetadataV1(connection);
    const bearer =
      credential.kind === "api-key"
        ? credential.token
        : credential.tokens.accessToken;
    const abandon = async () => {
      if (credential.kind === "grant") {
        await this.revokeGrant({
          ...credential.grant,
          ...credential.tokens,
        }).catch(() => undefined);
      }
    };
    if (
      !connection ||
      !url ||
      !metadata ||
      connection.state === "revoked" ||
      connection.state === "authorizing"
    ) {
      await abandon();
      return false;
    }
    const generation = this.randomId();
    const prepared = await this.host.credentials.prepareApiKey({
      accountId,
      connectionId,
      packageId: MCP_PACKAGE_ID,
      generation,
      apiKey:
        credential.kind === "api-key"
          ? credential.token
          : encodeMcpAccessSecretV1(credential.tokens),
    });
    const grant =
      credential.kind === "grant"
        ? await sealMcpGrantV1(this.host.credentials, {
            accountId,
            connectionId,
            generation,
            grant: {
              ...credential.grant,
              accessToken: credential.tokens.accessToken,
              ...(credential.tokens.refreshToken
                ? { refreshToken: credential.tokens.refreshToken }
                : {}),
            },
          })
        : undefined;
    await this.host.credentials.stagePreparedApiKey(prepared);
    let listed: { info: McpServerInfoV1; tools: McpToolV1[] };
    try {
      listed = await withMcpSessionV1(
        {
          url,
          token: bearer,
          ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
        },
        async (session) => ({
          info: session.info,
          tools: boundMcpCatalogToolsV1(await session.listTools()),
        }),
      );
    } catch (error) {
      await this.discard(connectionId, generation, true);
      await abandon();
      // A server that works keeps working with what it had; one that did not
      // says why the new credential did not help.
      if (connection.state === "failed") {
        await this.fail(
          accountId,
          connection,
          mcpFailureLineV1(error, credential.kind),
        );
      }
      return false;
    }
    const previous = await readMcpGrantV1(
      this.host.storage,
      this.host.credentials,
      { accountId, connectionId },
    ).catch(() => undefined);
    const updatedAt = new Date(this.now()).toISOString();
    const settled = await this.host.storage.transaction(
      async (storage: HostTransaction) => {
        const current = await this.host.settings.getConnection(
          accountId,
          connectionId,
          storage,
        );
        if (
          !current ||
          current.generation !== connection.generation ||
          current.state === "revoked" ||
          current.state === "authorizing"
        ) {
          return false;
        }
        await this.host.credentials.activate(
          { accountId, connectionId, packageId: MCP_PACKAGE_ID, generation },
          storage,
        );
        await this.host.settings.replaceConnection(
          accountId,
          connectionId,
          current.generation,
          {
            ...withoutFailure(current),
            generation,
            state: current.state === "disabled" ? "disabled" : "ready",
            authorization: authorizationOf(
              credential.kind,
              generation,
              updatedAt,
            ),
            safeMetadata: { ...metadata, ...this.serverMetadata(listed.info) },
          },
          storage,
        );
        if (grant) await storage.put(grant.key, grant.value);
        else await forgetMcpGrantV1(storage, connectionId);
        return true;
      },
    );
    if (!settled) {
      await this.discard(connectionId, generation, true);
      await abandon();
      return false;
    }
    // What this credential replaced is done with at the server too.
    if (previous && previous.generation !== generation) {
      await this.revokeGrant(previous).catch(() => undefined);
    }
    await publishMcpCatalogV1(this.catalogStorage(), {
      connectionId,
      generation,
      tools: listed.tools,
      now: this.now(),
      readConnection: this.readConnection(accountId, connectionId),
    });
    return true;
  }

  /**
   * A sign-in that did not finish says so on a server that is not working;
   * one that is working keeps working, and the answer to the command is
   * where the person learns the new sign-in did not take.
   */
  private async noteSignInFailure(
    accountId: string,
    connectionId: string,
    line: string,
  ): Promise<void> {
    const current = await this.host.settings.getConnection(
      accountId,
      connectionId,
    );
    if (current?.state === "failed") {
      await this.fail(accountId, current, line).catch(() => undefined);
    }
  }

  /** The sign-in hints a server gives when asked with no credential. */
  private async challenge(
    url: string,
  ): Promise<McpAuthChallengeV1 | undefined> {
    try {
      await withMcpSessionV1(
        { url, ...(this.host.fetch ? { fetch: this.host.fetch } : {}) },
        async (session) => {
          await session.listTools();
        },
      );
      return undefined;
    } catch (error) {
      return error instanceof McpUnauthorizedError
        ? error.challenge
        : undefined;
    }
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
        if (connection.state === "failed") {
          return this.receipt(
            command,
            connection.connectionId,
            (await this.reconnect(accountId, connection))
              ? "applied"
              : "failed",
          );
        }
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
   * Asks a server that is not working again, with whatever credential it
   * still holds. It comes back `ready` at the generation it had, or stays
   * failed with the reason as it is now.
   */
  private async reconnect(
    accountId: string,
    connection: ConnectionView,
  ): Promise<boolean> {
    const url = mcpServerUrlV1(connection);
    const metadata = mcpSafeMetadataV1(connection);
    if (!url || !metadata || "refusal" in classifyMcpServerUrlV1(url)) {
      return false;
    }
    const kind = credentialKindOf(connection);
    let token: string | undefined;
    if (kind !== "none" && connection.authorization?.credential.configured) {
      try {
        token = await this.openToken(accountId, connection);
      } catch {
        await this.fail(
          accountId,
          connection,
          kind === "grant" ? MCP_SIGN_IN_AGAIN_LINE_V1 : LOST_TOKEN_LINE,
        );
        return false;
      }
    }
    let listed: { info: McpServerInfoV1; tools: McpToolV1[] };
    try {
      listed = await withMcpSessionV1(
        {
          url,
          ...(token ? { token } : {}),
          ...(metadata.transport ? { transport: metadata.transport } : {}),
          ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
        },
        async (session) => ({
          info: session.info,
          tools: boundMcpCatalogToolsV1(await session.listTools()),
        }),
      );
    } catch (error) {
      await this.failWith(accountId, connection, error, token ? kind : "none");
      return false;
    }
    const settled = await this.host.storage.transaction(
      async (storage: HostTransaction) => {
        const current = await this.host.settings.getConnection(
          accountId,
          connection.connectionId,
          storage,
        );
        if (
          current?.state !== "failed" ||
          current.generation !== connection.generation
        ) {
          return false;
        }
        await this.host.settings.replaceConnection(
          accountId,
          current.connectionId,
          current.generation,
          {
            ...withoutFailure(current),
            state: "ready",
            safeMetadata: { ...metadata, ...this.serverMetadata(listed.info) },
          },
          storage,
        );
        return true;
      },
    );
    if (!settled) return false;
    await publishMcpCatalogV1(this.catalogStorage(), {
      connectionId: connection.connectionId,
      generation: connection.generation ?? "",
      tools: listed.tools,
      now: this.now(),
      readConnection: this.readConnection(accountId, connection.connectionId),
    });
    return true;
  }

  /**
   * Removes a server: its credential, its directory and its name. A signed-in
   * server's grant is revoked at its authorization server as well, when that
   * server says where — FrockBot was given it, and is done with it.
   */
  private async retire(
    accountId: string,
    connection: ConnectionView,
  ): Promise<void> {
    const grant = await readMcpGrantV1(
      this.host.storage,
      this.host.credentials,
      { accountId, connectionId: connection.connectionId },
    ).catch(() => undefined);
    await this.host.settings.replaceConnection(
      accountId,
      connection.connectionId,
      connection.generation,
      { ...withoutFailure(connection), state: "revoked" },
    );
    await this.host.credentials.disconnect(connection.connectionId);
    await forgetMcpCatalogV1(this.host.storage, connection.connectionId);
    await forgetMcpGrantV1(this.host.storage, connection.connectionId);
    await forgetMcpSignInV1(this.host.storage, connection.connectionId);
    if (grant) await this.revokeGrant(grant).catch(() => undefined);
  }

  /**
   * Revokes a grant: the refresh token, which takes the access tokens issued
   * under it with it, or the access token when there is nothing else.
   */
  private async revokeGrant(
    grant: Pick<McpSignInGrantV1, "server" | "client"> & {
      accessToken: string;
      refreshToken?: string;
    },
  ): Promise<void> {
    await revokeMcpSignInV1({
      server: grant.server,
      client: grant.client,
      ...(grant.refreshToken
        ? { token: grant.refreshToken, hint: "refresh_token" as const }
        : { token: grant.accessToken, hint: "access_token" as const }),
      ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
    });
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
    authorization?: ConnectionAuthorizationViewV1,
  ): Promise<void> {
    const current = await this.host.settings.getConnection(
      accountId,
      connection.connectionId,
    );
    if (
      !current ||
      current.state === "revoked" ||
      current.generation !== connection.generation ||
      (current.state === "failed" &&
        current.failure === failure &&
        authorization === undefined)
    ) {
      return;
    }
    await this.host.settings.replaceConnection(
      accountId,
      current.connectionId,
      current.generation,
      {
        ...current,
        state: "failed",
        failure,
        ...(authorization ? { authorization } : {}),
      },
    );
    await forgetMcpCatalogV1(this.host.storage, current.connectionId);
  }

  /**
   * Settles a server that would not answer. One that refused for want of a
   * credential it was never given is asked whether it offers a sign-in, and
   * when it does the Connection says it signs in, so the person is offered
   * that rather than a token.
   */
  private async failWith(
    accountId: string,
    connection: ConnectionView,
    error: unknown,
    credential: McpCredentialKindV1,
  ): Promise<void> {
    const url = mcpServerUrlV1(connection);
    if (
      error instanceof McpUnauthorizedError &&
      credential === "none" &&
      url &&
      this.host.keyring
    ) {
      const offered = await discoverMcpSignInV1({
        url,
        challenge: error.challenge,
        ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
      }).then(
        () => true,
        () => false,
      );
      if (offered) {
        await this.fail(
          accountId,
          connection,
          MCP_SIGN_IN_LINE_V1,
          authorizationOf(
            "grant",
            undefined,
            new Date(this.now()).toISOString(),
          ),
        );
        return;
      }
    }
    await this.fail(accountId, connection, mcpFailureLineV1(error, credential));
  }

  /**
   * Lists a server's tools again and stores them. Concurrent callers share
   * one listing. A server that refuses its credential is failed — only a
   * person can give it a new one — and one that is merely unreachable keeps
   * the tools it last listed and is retried on the alarm.
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
      let token: string | undefined;
      try {
        token = await this.openToken(userId, connection);
      } catch (error) {
        // A signed-in server whose refresh did not go through has been told
        // to sign in again already; anything else is retried.
        if (credentialKindOf(connection) === "grant") return;
        throw error;
      }
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
        await this.failWith(
          userId,
          connection,
          error,
          credentialKindOf(connection),
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

  /**
   * A signed-in server's access token, refreshed when it would expire inside
   * a lease. The credential store records the refresh before it is sent; a
   * refresh that fails, or one that stopped partway, asks the person to sign
   * in again, because a refresh token may be good only once.
   */
  private async freshen(
    userId: string,
    connection: ConnectionView,
  ): Promise<void> {
    const generation = connection.generation;
    if (credentialKindOf(connection) !== "grant" || !generation) return;
    const connectionId = connection.connectionId;
    try {
      await this.host.credentials.refreshActiveSecret({
        accountId: userId,
        connectionId,
        packageId: MCP_PACKAGE_ID,
        generation,
        needsRefresh: (secret) => {
          const { expiresAt } = decodeMcpAccessSecretV1(secret);
          return (
            expiresAt !== undefined &&
            expiresAt <= this.now() + REFRESH_BEFORE_EXPIRY_MS
          );
        },
        refresh: async () => {
          const grant = await readMcpGrantV1(
            this.host.storage,
            this.host.credentials,
            { accountId: userId, connectionId, generation },
          );
          if (!grant?.refreshToken) {
            throw new McpSignInError(MCP_SIGN_IN_AGAIN_LINE_V1);
          }
          const tokens = await refreshMcpSignInV1({
            server: grant.server,
            client: grant.client,
            refreshToken: grant.refreshToken,
            ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
            now: this.now(),
          });
          const sealed = await sealMcpGrantV1(this.host.credentials, {
            accountId: userId,
            connectionId,
            generation,
            grant: {
              server: grant.server,
              client: grant.client,
              accessToken: tokens.accessToken,
              ...(tokens.refreshToken
                ? { refreshToken: tokens.refreshToken }
                : {}),
            },
          });
          await this.host.storage.put(sealed.key, sealed.value);
          return encodeMcpAccessSecretV1(tokens);
        },
      });
    } catch (error) {
      await this.fail(userId, connection, MCP_SIGN_IN_AGAIN_LINE_V1).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /** Opens the server's bearer token here, in the object that holds it. */
  private async openToken(
    userId: string,
    connection: ConnectionView,
  ): Promise<string | undefined> {
    const kind = credentialKindOf(connection);
    if (kind === "none" || !connection.generation) return undefined;
    if (kind === "grant") await this.freshen(userId, connection);
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
      const secret = await this.host.credentials.openLease({
        accountId: userId,
        packageId: MCP_PACKAGE_ID,
        lease,
      });
      return kind === "grant"
        ? decodeMcpAccessSecretV1(secret).accessToken
        : secret;
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
