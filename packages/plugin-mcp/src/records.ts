/**
 * The durable MCP server record, its refusal ledger, and the wire shapes the
 * lifecycle speaks.
 *
 * L2 made a remote MCP server a Connection: the handshake decided whether it
 * was `ready` or `failed`, and a mount that could not reach it simply offered
 * no tools. That is invisible. This module is the durable half GrokBot's
 * `GetMcpServerStatus` projects: one record per server, owned by the User
 * Durable Object beside the Connection, carrying the state a User can act on
 * — `connecting`, `ready`, `needs-auth`, `error` — the instructions that
 * become the server's tool-set description, and the `serverEpoch` a restart
 * bumps.
 *
 * Every shape here decodes strictly. A record read back from storage that
 * carries a key this build does not know is a corrupt record, not a record
 * with an extra field: an MCP server's durable state is small enough that
 * tolerance would only hide a bug.
 */

import { McpProtocolError } from "./mcp-client.js";

export const MCP_SERVER_RECORD_PREFIX = "mcp-server:";
export const MCP_SERVER_INDEX_KEY = "mcp-server-index";
export const MCP_REFUSAL_PREFIX = "mcp-refusal:";
export const MCP_REFUSAL_INDEX_KEY = "mcp-refusal-index";

/** How many refusals the ledger keeps before the oldest is evicted. */
export const MAX_MCP_REFUSALS_V1 = 32;
/** The instruction text a User may attach to one server. */
export const MAX_MCP_INSTRUCTIONS_BYTES_V1 = 4_096;

export function mcpServerRecordKeyV1(serverId: string): string {
  return `${MCP_SERVER_RECORD_PREFIX}${serverId}`;
}

export function mcpRefusalKeyV1(refusalId: string): string {
  return `${MCP_REFUSAL_PREFIX}${refusalId}`;
}

/**
 * A server's lifecycle state, which is exactly GrokBot's: `needs-auth` is a
 * server that answered but refused the credential, `error` is one that could
 * not be reached or did not speak the protocol. The two are distinguished
 * because only one of them a User can fix by re-authorizing.
 */
export type McpServerStateV1 = "connecting" | "ready" | "needs-auth" | "error";

export type McpTransportRequestV1 = "streamable-http" | "sse" | "stdio";

/**
 * Why a server is not `ready`, or why an operation was refused. Codes, not
 * prose: the message is the server's own words and changes; the code is what
 * a surface and a test may branch on.
 */
export type McpFailureCodeV1 =
  | "unreachable"
  | "unauthorized"
  | "protocol"
  | "unsupported-transport"
  | "server-quota"
  | "tool-quota"
  | "response-quota"
  // The three the `mcp-oauth` grant driver adds. They are distinct from
  // `unauthorized` on purpose: `unauthorized` is a credential the User can
  // replace, and each of these is a different repair — re-run the connect
  // card, use a different server, or wait.
  | "authorization-discovery"
  | "unsupported-client-authentication"
  | "authorization-quota";

const FAILURE_CODES = new Set<string>([
  "unreachable",
  "unauthorized",
  "protocol",
  "unsupported-transport",
  "server-quota",
  "tool-quota",
  "response-quota",
  "authorization-discovery",
  "unsupported-client-authentication",
  "authorization-quota",
]);

export interface McpServerFailureV1 {
  code: McpFailureCodeV1;
  message: string;
  at: string;
}

export interface McpServerRecordV1 {
  schemaVersion: 1;
  /** The Connection's own id. One Connection is one server; there is no second identity. */
  serverId: string;
  label: string;
  url: string;
  transport: "streamable-http" | "sse";
  instructions?: string;
  /**
   * Bumped by `mcp/restart`. It participates in the Capability's resolution
   * key, so the next admitted Turn resolves a different mount and
   * re-handshakes; the in-flight Turn keeps the client it already has.
   */
  serverEpoch: number;
  state: McpServerStateV1;
  protocolVersion?: string;
  toolCount: number;
  toolsHash: string;
  lastHandshakeAt: string;
  failure?: McpServerFailureV1;
}

/**
 * A durable refusal: an operation the User asked for that this build will not
 * perform. A stdio server and a seventeenth server both land here, because
 * "the request left no trace" is the one outcome a durable system may not
 * produce.
 */
export interface McpRefusalRecordV1 {
  schemaVersion: 1;
  refusalId: string;
  commandId: string;
  code: McpFailureCodeV1;
  message: string;
  at: string;
  label?: string;
  url?: string;
  transport?: McpTransportRequestV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new Error(`${label} carries unknown field "${key}"`);
    }
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return value as string;
}

function count(value: unknown, label: string, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function failure(value: unknown): McpServerFailureV1 {
  const item = record(value, "MCP server failure");
  exact(item, ["code", "message", "at"], "MCP server failure");
  if (typeof item.code !== "string" || !FAILURE_CODES.has(item.code)) {
    throw new Error("MCP server failure code is invalid");
  }
  return {
    code: item.code as McpFailureCodeV1,
    message: text(item.message, "MCP server failure message", 2_000),
    at: timestamp(item.at, "MCP server failure timestamp"),
  };
}

export function decodeMcpServerRecordV1(input: unknown): McpServerRecordV1 {
  const value = record(input, "MCP server record");
  exact(
    value,
    [
      "schemaVersion",
      "serverId",
      "label",
      "url",
      "transport",
      "instructions",
      "serverEpoch",
      "state",
      "protocolVersion",
      "toolCount",
      "toolsHash",
      "lastHandshakeAt",
      "failure",
    ],
    "MCP server record",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP server record schemaVersion is unsupported");
  }
  if (value.transport !== "streamable-http" && value.transport !== "sse") {
    throw new Error("MCP server record transport is invalid");
  }
  if (
    value.state !== "connecting" &&
    value.state !== "ready" &&
    value.state !== "needs-auth" &&
    value.state !== "error"
  ) {
    throw new Error("MCP server record state is invalid");
  }
  return {
    schemaVersion: 1,
    serverId: text(value.serverId, "MCP server id", 128),
    label: text(value.label, "MCP server label", 120),
    url: text(value.url, "MCP server url", 2_048),
    transport: value.transport,
    ...(value.instructions === undefined
      ? {}
      : {
          instructions: text(
            value.instructions,
            "MCP server instructions",
            MAX_MCP_INSTRUCTIONS_BYTES_V1,
          ),
        }),
    serverEpoch: count(value.serverEpoch, "MCP server epoch", 1_000_000),
    state: value.state,
    ...(value.protocolVersion === undefined
      ? {}
      : {
          protocolVersion: text(
            value.protocolVersion,
            "MCP protocol version",
            64,
          ),
        }),
    toolCount: count(value.toolCount, "MCP server tool count", 4_096),
    toolsHash:
      value.toolsHash === "" ? "" : text(value.toolsHash, "MCP tools hash", 64),
    lastHandshakeAt: timestamp(value.lastHandshakeAt, "MCP handshake time"),
    ...(value.failure === undefined ? {} : { failure: failure(value.failure) }),
  };
}

export function decodeMcpRefusalRecordV1(input: unknown): McpRefusalRecordV1 {
  const value = record(input, "MCP refusal record");
  exact(
    value,
    [
      "schemaVersion",
      "refusalId",
      "commandId",
      "code",
      "message",
      "at",
      "label",
      "url",
      "transport",
    ],
    "MCP refusal record",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP refusal record schemaVersion is unsupported");
  }
  if (typeof value.code !== "string" || !FAILURE_CODES.has(value.code)) {
    throw new Error("MCP refusal code is invalid");
  }
  if (
    value.transport !== undefined &&
    value.transport !== "streamable-http" &&
    value.transport !== "sse" &&
    value.transport !== "stdio"
  ) {
    throw new Error("MCP refusal transport is invalid");
  }
  return {
    schemaVersion: 1,
    refusalId: text(value.refusalId, "MCP refusal id", 128),
    commandId: text(value.commandId, "MCP refusal commandId", 128),
    code: value.code as McpFailureCodeV1,
    message: text(value.message, "MCP refusal message", 2_000),
    at: timestamp(value.at, "MCP refusal timestamp"),
    ...(value.label === undefined
      ? {}
      : { label: text(value.label, "MCP refusal label", 120) }),
    ...(value.url === undefined
      ? {}
      : { url: text(value.url, "MCP refusal url", 2_048) }),
    ...(value.transport === undefined
      ? {}
      : { transport: value.transport as McpTransportRequestV1 }),
  };
}

/**
 * The status projection: GrokBot's `GetMcpServerStatus`, plus the refusal
 * ledger and the quotas every one of them is held to, so a surface can show a
 * User both what their servers are doing and what the ceiling is.
 */
export interface McpServerStatusViewV1 {
  schemaVersion: 1;
  servers: McpServerRecordV1[];
  refusals: McpRefusalRecordV1[];
  quotas: {
    maxServers: number;
    maxToolsPerServer: number;
    maxResponseBytes: number;
  };
}

export function decodeMcpServerStatusViewV1(
  input: unknown,
): McpServerStatusViewV1 {
  const value = record(input, "MCP status view");
  exact(
    value,
    ["schemaVersion", "servers", "refusals", "quotas"],
    "MCP status view",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP status view schemaVersion is unsupported");
  }
  if (!Array.isArray(value.servers) || !Array.isArray(value.refusals)) {
    throw new Error("MCP status view is invalid");
  }
  const quotas = record(value.quotas, "MCP status quotas");
  exact(
    quotas,
    ["maxServers", "maxToolsPerServer", "maxResponseBytes"],
    "MCP status quotas",
  );
  return {
    schemaVersion: 1,
    servers: value.servers.map(decodeMcpServerRecordV1),
    refusals: value.refusals.map(decodeMcpRefusalRecordV1),
    quotas: {
      maxServers: count(quotas.maxServers, "maxServers", 4_096),
      maxToolsPerServer: count(
        quotas.maxToolsPerServer,
        "maxToolsPerServer",
        4_096,
      ),
      maxResponseBytes: count(
        quotas.maxResponseBytes,
        "maxResponseBytes",
        1_073_741_824,
      ),
    },
  };
}

export interface McpAddServerCommandV1 {
  schemaVersion: 1;
  type: "mcp/add-server";
  commandId: string;
  label: string;
  url: string;
  transport: McpTransportRequestV1;
  apiKey?: string;
  headerName?: string;
  instructions?: string;
}

export interface McpSetInstructionsCommandV1 {
  schemaVersion: 1;
  type: "mcp/set-instructions";
  commandId: string;
  serverId: string;
  /** An empty string clears the instructions; absence is not how you unset. */
  instructions: string;
}

export interface McpRestartCommandV1 {
  schemaVersion: 1;
  type: "mcp/restart";
  commandId: string;
  serverId: string;
}

/**
 * GrokBot's `AuthenticateMcpServer`, as the constitution requires it to be: a
 * Bot records a durable pending decision for its User and receives no link, no
 * token and no grant. Chat-only, because an automation Turn has no User in
 * front of it to decide.
 */
export interface McpRequestAuthorizationCommandV1 {
  schemaVersion: 1;
  type: "mcp/request-authorization";
  commandId: string;
  serverId: string;
}

export type McpLifecycleCommandV1 =
  | McpAddServerCommandV1
  | McpSetInstructionsCommandV1
  | McpRestartCommandV1
  | McpRequestAuthorizationCommandV1;

export function decodeMcpLifecycleCommandV1(
  input: unknown,
): McpLifecycleCommandV1 {
  const value = record(input, "MCP lifecycle command");
  if (value.schemaVersion !== 1) {
    throw new Error("MCP lifecycle command schemaVersion is unsupported");
  }
  const commandId = text(value.commandId, "commandId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commandId)) {
    throw new Error("MCP lifecycle commandId is invalid");
  }
  switch (value.type) {
    case "mcp/add-server": {
      exact(
        value,
        [
          "schemaVersion",
          "type",
          "commandId",
          "label",
          "url",
          "transport",
          ...(Object.hasOwn(value, "apiKey") ? ["apiKey"] : []),
          ...(Object.hasOwn(value, "headerName") ? ["headerName"] : []),
          ...(Object.hasOwn(value, "instructions") ? ["instructions"] : []),
        ],
        "mcp/add-server",
      );
      if (
        value.transport !== "streamable-http" &&
        value.transport !== "sse" &&
        value.transport !== "stdio"
      ) {
        throw new Error("MCP transport is invalid");
      }
      return {
        schemaVersion: 1,
        type: "mcp/add-server",
        commandId,
        label: text(value.label, "label", 120),
        url: text(value.url, "url", 2_048),
        transport: value.transport,
        ...(value.apiKey === undefined
          ? {}
          : { apiKey: text(value.apiKey, "apiKey", 16_384) }),
        ...(value.headerName === undefined
          ? {}
          : { headerName: text(value.headerName, "headerName", 128) }),
        ...(value.instructions === undefined
          ? {}
          : {
              instructions: text(
                value.instructions,
                "instructions",
                MAX_MCP_INSTRUCTIONS_BYTES_V1,
              ),
            }),
      };
    }
    case "mcp/set-instructions": {
      exact(
        value,
        ["schemaVersion", "type", "commandId", "serverId", "instructions"],
        "mcp/set-instructions",
      );
      if (
        typeof value.instructions !== "string" ||
        value.instructions.length > MAX_MCP_INSTRUCTIONS_BYTES_V1
      ) {
        throw new Error("MCP instructions are invalid");
      }
      return {
        schemaVersion: 1,
        type: "mcp/set-instructions",
        commandId,
        serverId: text(value.serverId, "serverId", 128),
        instructions: value.instructions,
      };
    }
    case "mcp/restart": {
      exact(
        value,
        ["schemaVersion", "type", "commandId", "serverId"],
        "mcp/restart",
      );
      return {
        schemaVersion: 1,
        type: "mcp/restart",
        commandId,
        serverId: text(value.serverId, "serverId", 128),
      };
    }
    case "mcp/request-authorization": {
      exact(
        value,
        ["schemaVersion", "type", "commandId", "serverId"],
        "mcp/request-authorization",
      );
      return {
        schemaVersion: 1,
        type: "mcp/request-authorization",
        commandId,
        serverId: text(value.serverId, "serverId", 128),
      };
    }
    default:
      throw new Error(
        `MCP lifecycle command "${String(value.type)}" is unknown`,
      );
  }
}

export interface McpLifecycleReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied" | "refused" | "failed";
  serverId?: string;
  code?: McpFailureCodeV1;
  failure?: string;
}

export function decodeMcpLifecycleReceiptV1(
  input: unknown,
): McpLifecycleReceiptV1 {
  const value = record(input, "MCP lifecycle receipt");
  exact(
    value,
    ["schemaVersion", "commandId", "status", "serverId", "code", "failure"],
    "MCP lifecycle receipt",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP lifecycle receipt schemaVersion is unsupported");
  }
  if (
    value.status !== "applied" &&
    value.status !== "refused" &&
    value.status !== "failed"
  ) {
    throw new Error("MCP lifecycle receipt status is invalid");
  }
  if (
    value.code !== undefined &&
    (typeof value.code !== "string" || !FAILURE_CODES.has(value.code))
  ) {
    throw new Error("MCP lifecycle receipt code is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: text(value.commandId, "commandId", 128),
    status: value.status,
    ...(value.serverId === undefined
      ? {}
      : { serverId: text(value.serverId, "serverId", 128) }),
    ...(value.code === undefined
      ? {}
      : { code: value.code as McpFailureCodeV1 }),
    ...(value.failure === undefined
      ? {}
      : { failure: text(value.failure, "failure", 2_000) }),
  };
}

/**
 * What one mount of a server found, as it crosses from the Bot Durable Object
 * to the User Durable Object that owns the record. Decoded at the seam like
 * every other inbound value: a Bot may report an outcome, never a record.
 */
export interface McpMountOutcomeReportV1 {
  connectionId: string;
  serverEpoch?: number;
  state: "ready" | "needs-auth" | "error";
  failure?: { code: McpFailureCodeV1; message: string };
  protocolVersion?: string;
  toolCount?: number;
  toolsHash?: string;
}

export function decodeMcpMountOutcomeV1(
  input: unknown,
): McpMountOutcomeReportV1 {
  const value = record(input, "MCP mount outcome");
  exact(
    value,
    [
      "connectionId",
      "serverEpoch",
      "state",
      "failure",
      "protocolVersion",
      "toolCount",
      "toolsHash",
    ],
    "MCP mount outcome",
  );
  if (
    value.state !== "ready" &&
    value.state !== "needs-auth" &&
    value.state !== "error"
  ) {
    throw new Error("MCP mount outcome state is invalid");
  }
  let reported: { code: McpFailureCodeV1; message: string } | undefined;
  if (value.failure !== undefined) {
    const item = record(value.failure, "MCP mount failure");
    exact(item, ["code", "message"], "MCP mount failure");
    if (typeof item.code !== "string" || !FAILURE_CODES.has(item.code)) {
      throw new Error("MCP mount failure code is invalid");
    }
    reported = {
      code: item.code as McpFailureCodeV1,
      message: text(item.message, "MCP mount failure message", 2_000),
    };
  }
  return {
    connectionId: text(value.connectionId, "MCP mount connectionId", 128),
    ...(value.serverEpoch === undefined
      ? {}
      : {
          serverEpoch: count(value.serverEpoch, "MCP server epoch", 1_000_000),
        }),
    state: value.state,
    ...(reported ? { failure: reported } : {}),
    ...(value.protocolVersion === undefined
      ? {}
      : {
          protocolVersion: text(
            value.protocolVersion,
            "MCP protocol version",
            64,
          ),
        }),
    ...(value.toolCount === undefined
      ? {}
      : { toolCount: count(value.toolCount, "MCP tool count", 4_096) }),
    ...(value.toolsHash === undefined
      ? {}
      : { toolsHash: text(value.toolsHash, "MCP tools hash", 64) }),
  };
}

/**
 * What one enabled `mcp-tools` Capability resolves to. The `serverEpoch` is in it,
 * which is the whole of restart semantics: a restart changes this key, the
 * next admitted Turn resolves a different mount and re-handshakes, and the
 * in-flight Turn — already holding its client — is untouched.
 */
export function mcpCapabilityResolutionKeyV1(input: {
  connectionId: string;
  connectionGeneration?: string;
  serverEpoch?: number;
}): string {
  return [
    "mcp",
    input.connectionId,
    input.connectionGeneration ?? "no-generation",
    String(input.serverEpoch ?? 0),
  ].join(":");
}

/**
 * The record fields mirrored onto the Connection's `safeMetadata`, so the Bot
 * Durable Object reads the epoch and the instructions over the seam it
 * already has. The record in the User Durable Object stays the authority;
 * this is a projection of it.
 */
export function mcpConnectionMetadataV1(
  server: McpServerRecordV1,
): Record<string, string | number | boolean> {
  return {
    serverEpoch: server.serverEpoch,
    serverState: server.state,
    toolCount: server.toolCount,
    toolsHash: server.toolsHash,
    ...(server.protocolVersion
      ? { protocolVersion: server.protocolVersion }
      : {}),
    ...(server.instructions ? { instructions: server.instructions } : {}),
  };
}

/**
 * The Connection-level projection of a server that needs authorizing.
 *
 * The record in the User Durable Object is the authority; this is the small,
 * URL-free shape a client draws a connect card from. There is no redirect in
 * it and there never will be: a Bot may write this, and only an authenticated
 * User action mints a link.
 */
export function mcpPendingAuthorizationV1(
  server: McpServerRecordV1,
  at: string,
): {
  reason: string;
  since: string;
  connectionId: string;
  label: string;
} {
  return {
    reason: "needs-auth",
    since: at,
    connectionId: server.serverId,
    label: server.label,
  };
}

/**
 * Which failure a thrown handshake was. `needs-auth` and `error` are
 * different repairs — one is a credential the User can replace, the other is
 * a server that is not answering — so the classification is durable rather
 * than left to whoever reads the message.
 */
export function mcpFailureCodeV1(error: unknown): McpFailureCodeV1 {
  // An authorization failure classifies itself: the driver already knows
  // whether the server published no metadata, demanded a client secret, or
  // simply refused the grant, and re-deriving that from a message would be a
  // second, worse classifier.
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    FAILURE_CODES.has((error as { code: string }).code)
  ) {
    return (error as { code: McpFailureCodeV1 }).code;
  }
  if (
    error instanceof Error &&
    (error as { code?: unknown }).code === "authorization-failed"
  ) {
    return "unauthorized";
  }
  const status = error instanceof McpProtocolError ? error.status : undefined;
  if (status === 401 || status === 403) return "unauthorized";
  const message = error instanceof Error ? error.message : "";
  if (/more than \d+ tools/.test(message)) return "tool-quota";
  if (message.includes("response is too large")) return "response-quota";
  if (error instanceof McpProtocolError && status === undefined) {
    return "protocol";
  }
  return "unreachable";
}
