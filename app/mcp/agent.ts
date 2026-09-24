// What an MCP server is to a Bot: one external Tool Namespace carrying the
// server's tools, mounted for each ready server its User added.
//
// AUTHORITY. A namespace exists only through the enabled `mcp-tools`
// Capability bound to a `ready` Connection the runtime host has already
// authorized, and permission is asked again before a schema is disclosed and
// before a call is sent. A server's token — the one it was given, or the
// access token its sign-in holds, never the refresh token — is leased for one
// call under the call's effect id, opened here, used and settled; it never
// reaches a tool argument, a result or the log.
//
// SCHEMAS. The directory comes from the User's copy, so listing costs no
// round trip to the server; one tool's schema is read and pinned by the Turn
// the first time it is disclosed or called, so a remount of the same Turn
// keeps exactly what it used.
//
// EFFECTS. A call is an external effect with no idempotency key: MCP has
// none. It is sent once per occurrence. What went wrong is said as it is —
// the call never left, the server refused it, or it left and its outcome is
// unknown, in which case the model is told not to repeat it.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type { ConnectionView } from "@frockbot/core/configuration";
import type { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import {
  MCP_RESULT_MAX_BYTES_V1,
  McpRefusedError,
  mcpResultTextV1,
  McpUnauthorizedError,
  withMcpSessionV1,
  type McpFetchV1,
  type McpToolV1,
} from "./client.js";
import { MCP_CAPABILITY_ID, MCP_PACKAGE_ID } from "./definition.js";
import { decodeMcpAccessSecretV1 } from "./oauth.js";
import {
  MCP_CATALOG_UNAVAILABLE_MESSAGE_V1,
  MCP_STALE_CONTRACT_MESSAGE_V1,
  mcpSafeMetadataV1,
  mcpServerUrlV1,
  type McpSafeMetadataV1,
} from "./user.js";

/** Longest argument bag sent to a server. */
const MAX_ARGUMENT_BYTES = 64_000;
/** Longest set of server notes the prompt carries for one server. */
const MAX_PROMPT_INSTRUCTIONS = 800;

type McpRuntimeV1 = AgentRuntimeV1 & { credentials?: CredentialLeaseRuntime };

export interface McpRuntimeConfigV1 {
  userId: string;
  connection: ConnectionView;
  fetch?: McpFetchV1;
  /** Pins what `read` answers for this Turn under `pinId`: one tool of one server. */
  pinToolCatalog?(
    pinId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown>;
  /** The User's copy of the directory, or one tool's schema when named. */
  readCatalog?(toolName?: string): Promise<unknown>;
  /** Live permission for this Connection. Absent keeps the admitted snapshot. */
  permitConnection?(): Promise<boolean>;
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
}

/** One tool, as a Turn pins it. */
interface PinnedMcpToolV1 {
  schemaVersion: 1;
  tool: McpToolV1;
}

function decodePinnedTool(value: unknown): McpToolV1 {
  const pinned = value as Partial<PinnedMcpToolV1> | undefined;
  const tool = pinned?.tool;
  if (
    pinned?.schemaVersion !== 1 ||
    !tool ||
    typeof tool.name !== "string" ||
    typeof tool.description !== "string" ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema)
  ) {
    throw new Error("Pinned MCP tool is invalid");
  }
  return tool;
}

class CatalogRefusal extends Error {
  constructor(
    readonly status: "unavailable" | "stale-contract",
    message: string,
  ) {
    super(message);
    this.name = "CatalogRefusal";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function labelOf(
  connection: ConnectionView,
  metadata: McpSafeMetadataV1,
): string {
  return `"${connection.displayName}" (${metadata.host})`;
}

async function readDirectory(
  config: McpRuntimeConfigV1,
): Promise<{ name: string; description: string }[]> {
  if (!config.readCatalog) return [];
  try {
    const answer = (await config.readCatalog()) as
      { kind?: unknown; tools?: unknown } | undefined;
    if (answer?.kind !== "directory" || !Array.isArray(answer.tools)) {
      return [];
    }
    return (
      answer.tools as { name?: unknown; description?: unknown }[]
    ).flatMap((tool) =>
      typeof tool.name === "string" && typeof tool.description === "string"
        ? [{ name: tool.name, description: tool.description }]
        : [],
    );
  } catch {
    return [];
  }
}

/** Mount one MCP server's namespace for one Turn. */
export function createMcpFeatureV1(
  config: McpRuntimeConfigV1,
): RuntimeFeatureV1<McpRuntimeV1> {
  return async (runtime) => {
    const metadata = mcpSafeMetadataV1(config.connection);
    const url = mcpServerUrlV1(config.connection);
    if (!metadata || !url) {
      throw new Error("MCP server Connection is missing its address");
    }
    const directory = await readDirectory(config);
    const label = labelOf(config.connection, metadata);
    const notes = metadata.instructions?.slice(0, MAX_PROMPT_INSTRUCTIONS);
    return [
      runtime.tools.registerNamespace({
        name: metadata.namespace,
        description: `The User's MCP server ${label}.`,
        status: "ready",
        external: true,
        directory,
        useInstructions: [
          `Tools from the User's MCP server ${label}, a service outside FrockBot.`,
          `Find a tool with get_dynamic_tools({ "namespace": "${metadata.namespace}", "pattern": "<words in its name>" }) and read its schema with get_dynamic_tools({ "namespace": "${metadata.namespace}", "toolName": "<tool>" }) before calling it.`,
          "Every call reaches that server: say why in mcpDetails.description, and confirm anything that sends, posts or deletes.",
          ...(notes
            ? [
                `The server's own notes on its tools: <server_notes>${notes}</server_notes>`,
              ]
            : []),
        ].join(" "),
        resolveTool: (toolName) =>
          resolveMcpTool(config, runtime, metadata, url, toolName),
      }),
    ];
  };
}

async function resolveMcpTool(
  config: McpRuntimeConfigV1,
  runtime: McpRuntimeV1,
  metadata: McpSafeMetadataV1,
  url: string,
  toolName: string,
) {
  if (config.permitConnection && !(await config.permitConnection())) {
    return {
      status: "stale-contract" as const,
      message: MCP_STALE_CONTRACT_MESSAGE_V1,
    };
  }
  let tool: McpToolV1;
  try {
    tool = await loadPinnedTool(config, toolName);
  } catch (error) {
    return error instanceof CatalogRefusal
      ? { status: error.status, message: error.message }
      : {
          status: "unavailable" as const,
          message: MCP_CATALOG_UNAVAILABLE_MESSAGE_V1,
        };
  }
  return {
    status: "ready" as const,
    registration: {
      admissionCeiling: ["chat", "agent", "automation", "subagent"] as const,
      subagentRoleCeiling: ["executor"],
    },
    tools: [
      {
        namespace: metadata.namespace,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        idempotent: false,
        execute: (input: unknown, context: ToolExecutionContext) =>
          executeMcpToolV1(
            config,
            runtime,
            { url, metadata, tool },
            input,
            context,
          ),
      },
    ],
  };
}

/**
 * One tool's schema, pinned by the Turn under the Connection and the tool's
 * name, so a remount of the same Turn reads back exactly what it used.
 */
async function loadPinnedTool(
  config: McpRuntimeConfigV1,
  toolName: string,
): Promise<McpToolV1> {
  const read = async (): Promise<PinnedMcpToolV1> => {
    if (!config.readCatalog) {
      throw new CatalogRefusal(
        "unavailable",
        MCP_CATALOG_UNAVAILABLE_MESSAGE_V1,
      );
    }
    const answer = (await config.readCatalog(toolName)) as
      { kind?: unknown; tool?: unknown; message?: unknown } | undefined;
    if (answer?.kind === "tool") {
      return decodeAndWrap(answer.tool);
    }
    const message =
      typeof answer?.message === "string"
        ? answer.message
        : MCP_CATALOG_UNAVAILABLE_MESSAGE_V1;
    if (answer?.kind === "stale-contract") {
      throw new CatalogRefusal("stale-contract", message);
    }
    throw new CatalogRefusal("unavailable", message);
  };
  const loaded = config.pinToolCatalog
    ? await config.pinToolCatalog(
        `${config.connection.connectionId}/${toolName}`,
        read,
      )
    : await read();
  const tool = decodePinnedTool(loaded);
  if (tool.name !== toolName) {
    throw new CatalogRefusal("unavailable", MCP_CATALOG_UNAVAILABLE_MESSAGE_V1);
  }
  return tool;
}

function decodeAndWrap(value: unknown): PinnedMcpToolV1 {
  return {
    schemaVersion: 1,
    tool: decodePinnedTool({ schemaVersion: 1, tool: value }),
  };
}

/** Whether a server holds a credential a call leases. */
function holdsCredential(connection: ConnectionView): boolean {
  const kind = connection.authorization?.kind;
  return kind === "api-key" || kind === "grant";
}

/**
 * The bearer token for one call: the token the server was given, or the
 * access token its sign-in holds. Nothing else a sign-in keeps is leased.
 */
async function openToken(
  config: McpRuntimeConfigV1,
  runtime: McpRuntimeV1,
  effectId: string,
): Promise<string | undefined> {
  const connection = config.connection;
  if (!holdsCredential(connection)) return undefined;
  const generation = connection.generation;
  if (!generation || !config.leaseCredential || !runtime.credentials) {
    throw new Error("The server's token is unavailable");
  }
  const lease = await config.leaseCredential(effectId, generation);
  if (
    lease.effectId !== effectId ||
    lease.connectionId !== connection.connectionId ||
    lease.credentialGeneration !== generation
  ) {
    throw new Error("The server's token lease is invalid");
  }
  const secret = await runtime.credentials.open({
    accountId: config.userId,
    connectionId: connection.connectionId,
    packageId: MCP_PACKAGE_ID,
    lease,
  });
  return connection.authorization?.kind === "grant"
    ? decodeMcpAccessSecretV1(secret).accessToken
    : secret;
}

export async function executeMcpToolV1(
  config: McpRuntimeConfigV1,
  runtime: McpRuntimeV1,
  target: { url: string; metadata: McpSafeMetadataV1; tool: McpToolV1 },
  input: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (config.permitConnection && !(await config.permitConnection())) {
    return { content: MCP_STALE_CONTRACT_MESSAGE_V1, isError: true };
  }
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) {
    return {
      content: "The arguments are too large for this tool.",
      isError: true,
    };
  }
  const leased = holdsCredential(config.connection);
  let dispatched = false;
  try {
    let token: string | undefined;
    try {
      token = await openToken(config, runtime, context.effectId);
    } catch {
      return {
        content:
          "The call was not sent: this server's credential could not be opened. The User may need to sign in to it again, or give it a new token, in Connectors.",
        isError: true,
      };
    }
    const result = await withMcpSessionV1(
      {
        url: target.url,
        ...(target.metadata.transport
          ? { transport: target.metadata.transport }
          : {}),
        ...(token ? { token } : {}),
        ...(config.fetch ? { fetch: config.fetch } : {}),
        signal: context.signal,
      },
      (session) => {
        dispatched = true;
        return session.callTool(target.tool.name, args, context.signal);
      },
    );
    const text = mcpResultTextV1(result);
    if (result.isError === true) {
      return {
        content: `The server reported an error: ${text.slice(0, 4_000) || "no details"}`,
        isError: true,
      };
    }
    if (byteLength(text) > MCP_RESULT_MAX_BYTES_V1) {
      return {
        content:
          "The server's answer is too large to show. Ask for less at a time.",
        isError: true,
      };
    }
    return { content: text, isError: false };
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (error instanceof McpUnauthorizedError) {
      return {
        content:
          "The call was not run: the server refused this connection's credential. The User needs to sign in to it again, or give it a new token, in Connectors.",
        isError: true,
      };
    }
    if (!dispatched) {
      return {
        content:
          "The call was not sent: the server could not be reached. Try again later.",
        isError: true,
      };
    }
    if (error instanceof McpRefusedError) {
      return {
        content: `The server refused the call before running it: ${error.message} Check the inputs against the tool's schema.`,
        isError: true,
      };
    }
    return {
      content:
        "The call's outcome could not be confirmed. Do not repeat it; check the server for its result.",
      isError: true,
    };
  } finally {
    if (leased) {
      await config.settleCredential?.(context.effectId).catch(() => undefined);
    }
  }
}

/**
 * The enablement fence: a namespace exists for a Bot only through the
 * enabled `mcp-tools` Capability bound to a ready server of this Package.
 * Anything else mounts nothing.
 */
export function createConfiguredMcpRuntimeContributionV1(
  config: Omit<McpRuntimeConfigV1, "connection"> & {
    capability: {
      packageId: string;
      capabilityId: string;
      connectionId?: string;
    };
    connection?: ConnectionView;
  },
): RuntimeFeatureV1<McpRuntimeV1> | undefined {
  const { capability, connection } = config;
  if (
    capability.packageId !== MCP_PACKAGE_ID ||
    capability.capabilityId !== MCP_CAPABILITY_ID ||
    !capability.connectionId ||
    !connection ||
    connection.connectionId !== capability.connectionId ||
    connection.state !== "ready" ||
    !mcpSafeMetadataV1(connection) ||
    !mcpServerUrlV1(connection)
  ) {
    return undefined;
  }
  return createMcpFeatureV1({ ...config, connection });
}
