/**
 * The runtime Contribution: one enabled Assignment of `mcp-tools` becomes one
 * remote MCP server's tools in the Bot's tool registry.
 *
 * Everything the Bot ever sees of a server passes through here, and every byte
 * of it is bounded. The server is contacted with the Package's own `fetch`, so
 * the outbound seam the deployment controls is the only way out; the API key,
 * when there is one, arrives as an opaque credential lease and is opened
 * against the keyring the Bot's own host holds.
 */
import {
  openCredentialV1,
  parseCredentialKeyringV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import type { ConnectionView } from "@frockbot/configuration-core";
import type { ToolDefinition, TurnTypeV1 } from "@frockbot/kernel-contracts";
import type { Context, Plugin } from "cordis";
import {
  McpClient,
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_TOOLS_PER_SERVER,
  type McpFetch,
  type McpToolDeclarationV1,
  type McpTransportV1,
} from "./mcp-client.js";
import { decodeOutboundMcpUrlV1 } from "./ssrf.js";
import {
  mcpAssignmentResolutionKeyV1,
  mcpFailureCodeV1,
  MAX_MCP_INSTRUCTIONS_BYTES_V1,
  type McpFailureCodeV1,
  type McpServerStatusViewV1,
} from "./records.js";

/**
 * The global `fetch`, bound. A bare reference to it throws "Illegal
 * invocation" inside a Durable Object, where the built-in checks its
 * receiver.
 */
const boundFetch: McpFetch = (input, init) => fetch(input, init);

export const MCP_PACKAGE_ID = "mcp";
export const MCP_CAPABILITY_ID = "mcp-tools";
export const MCP_CONNECTION_TYPE_ID = "mcp-remote";
export const MCP_KEYED_CONNECTION_TYPE_ID = "mcp-remote-key";

/** The manifest's admission ceiling, restated where registration happens. */
export const MCP_TOOL_TURN_TYPES: readonly TurnTypeV1[] = [
  "chat",
  "automation",
  "subagent",
  "channel",
];

/**
 * The durable per-User ceiling on remote MCP servers. Counted over the enabled
 * Assignments of this Package, so a Bot cannot be handed a seventeenth server
 * by adding one more Assignment.
 */
export const MAX_MCP_SERVERS_PER_USER_V1 = 16;

/** What one mount of a server found, as the durable record records it. */
export interface McpMountOutcomeV1 {
  connectionId: string;
  serverEpoch?: number;
  state: "ready" | "needs-auth" | "error";
  failure?: { code: McpFailureCodeV1; message: string };
  protocolVersion?: string;
  toolCount?: number;
  toolsHash?: string;
}

/**
 * The server's durable lifecycle fields as they reach the Bot: mirrored onto
 * the Connection's `safeMetadata` by the User Durable Object, which owns the
 * record. The Bot never invents them, and an absent mirror is a server that
 * has not been through the lifecycle yet, not a failure.
 */
export function mcpConnectionLifecycleV1(connection: {
  safeMetadata?: Record<string, unknown>;
}): { serverEpoch?: number; instructions?: string } {
  const metadata = connection.safeMetadata ?? {};
  const epoch = metadata.serverEpoch;
  const instructions = metadata.instructions;
  return {
    ...(typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0
      ? { serverEpoch: epoch }
      : {}),
    ...(typeof instructions === "string" &&
    instructions.length > 0 &&
    instructions.length <= MAX_MCP_INSTRUCTIONS_BYTES_V1
      ? { instructions }
      : {}),
  };
}

export interface McpConnectionSettingsV1 {
  url: URL;
  transport: McpTransportV1;
  headerName: string;
}

/**
 * Decode the Connection-scoped settings the manifest declares. Anything the
 * SSRF rules refuse, or a transport this build does not speak, is a refusal
 * here rather than a request that leaves the Durable Object.
 */
export function decodeMcpConnectionSettingsV1(
  settings: Record<string, unknown> | undefined,
): McpConnectionSettingsV1 {
  const url = decodeOutboundMcpUrlV1(settings?.url);
  const transport = settings?.transport ?? "streamable-http";
  if (transport !== "streamable-http" && transport !== "sse") {
    throw new Error("MCP transport is unsupported");
  }
  const headerName = settings?.["header-name"] ?? "Authorization";
  if (
    typeof headerName !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(headerName)
  ) {
    throw new Error("MCP key header name is invalid");
  }
  return { url, transport, headerName };
}

/**
 * The name one server's tool is offered to the model under:
 * `mcp__<server>__<tool>`. The server segment comes from the Connection's own
 * label, so a User who renames a server renames its tools; the tool segment is
 * the server's name with everything a model tool name may not carry replaced.
 */
export function mcpToolNameV1(serverSlug: string, toolName: string): string {
  const tool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `mcp__${serverSlug}__${tool}`;
}

/** The server segment of a tool name, derived from the Connection. */
export function mcpServerSlugV1(connection: {
  connectionId: string;
  displayName?: string;
}): string {
  const fromLabel = (connection.displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (fromLabel) return fromLabel.replace(/-/g, "_");
  return connection.connectionId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface McpRuntimeContributionConfig {
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
    state: string;
  };
  /**
   * This Assignment's ordinal among the enabled Assignments of this Package,
   * which is what makes the per-User server ceiling countable from inside a
   * per-Assignment factory.
   */
  assignmentIndex?: number;
  userId: string;
  readSecret(name: string): string | undefined;
  authorizeConnection(): Promise<ConnectionView>;
  /** The Package's own outbound seam. */
  fetch?: McpFetch;
  /** The credential lease for a keyed server, from the User's authority. */
  leaseCredential?(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential?(effectId: string): Promise<void>;
  /**
   * Where a mount failure goes in-process: a Bot whose server is unreachable
   * is offered no tools rather than a broken one.
   */
  onFailure?(reason: string): void;
  /**
   * Where a mount outcome goes durably. The User Durable Object owns the
   * server record, so this is how an unreachable server or a refused
   * credential becomes a visible `error`/`needs-auth` on the User's own
   * surface instead of a Bot that quietly lost its tools.
   */
  onOutcome?(outcome: McpMountOutcomeV1): Promise<void> | void;
  now?: () => number;
  randomId?: () => string;
}

/**
 * Resolve one Assignment into a mounted runtime Plugin. The handshake and
 * `tools/list` happen here, before the Plugin mounts, so a server that cannot
 * be reached contributes nothing instead of half-registering.
 */
export async function createConfiguredMcpRuntimeContribution(
  config: McpRuntimeContributionConfig,
): Promise<Plugin.Function | undefined> {
  if (
    config.assignment.packageId !== MCP_PACKAGE_ID ||
    config.assignment.capabilityId !== MCP_CAPABILITY_ID ||
    config.assignment.state !== "enabled" ||
    !config.assignment.connectionId
  ) {
    return undefined;
  }
  if ((config.assignmentIndex ?? 0) >= MAX_MCP_SERVERS_PER_USER_V1) {
    config.onFailure?.(
      `A User may assign at most ${MAX_MCP_SERVERS_PER_USER_V1} MCP servers`,
    );
    return undefined;
  }
  const fetchImpl = config.fetch ?? boundFetch;
  let client: McpClient | undefined;
  let lifecycle: { serverEpoch?: number; instructions?: string } = {};
  const connectionId = config.assignment.connectionId;
  try {
    const connection = await config.authorizeConnection();
    lifecycle = mcpConnectionLifecycleV1(connection);
    if (connection.state !== "ready") {
      throw new Error("MCP Connection is not ready");
    }
    const settings = decodeMcpConnectionSettingsV1(connection.settings);
    const apiKey =
      connection.connectionTypeId === MCP_KEYED_CONNECTION_TYPE_ID
        ? await openAssignedCredential(config, connection)
        : undefined;
    client = new McpClient({
      url: settings.url,
      transport: settings.transport,
      fetch: fetchImpl,
      ...(apiKey ? { apiKey, headerName: settings.headerName } : {}),
      maxResponseBytes: MAX_MCP_RESPONSE_BYTES,
      maxTools: MAX_MCP_TOOLS_PER_SERVER,
    });
    const handshake = await client.connect();
    const tools = await client.listTools();
    try {
      await config.onOutcome?.({
        connectionId,
        ...(lifecycle.serverEpoch === undefined
          ? {}
          : { serverEpoch: lifecycle.serverEpoch }),
        state: "ready",
        protocolVersion: handshake.protocolVersion,
        toolCount: tools.length,
      });
    } catch {
      // The record is a projection, not the authority for this mount: a User
      // Durable Object that cannot be reached must not cost the Bot the tools
      // its server just listed.
    }
    return createMcpToolPlugin({
      client,
      serverSlug: mcpServerSlugV1(connection),
      serverLabel: connection.displayName,
      tools,
      ...(lifecycle.instructions
        ? { instructions: lifecycle.instructions }
        : {}),
    });
  } catch (error) {
    await client?.close().catch(() => undefined);
    const message =
      error instanceof Error ? error.message : "MCP server is unavailable";
    config.onFailure?.(message);
    const code = mcpFailureCodeV1(error);
    try {
      await config.onOutcome?.({
        connectionId,
        ...(lifecycle.serverEpoch === undefined
          ? {}
          : { serverEpoch: lifecycle.serverEpoch }),
        state: code === "unauthorized" ? "needs-auth" : "error",
        failure: { code, message },
      });
    } catch {
      // The record is best-effort from inside a mount: a User Durable Object
      // that cannot be reached must not turn a missing tool into a failed
      // Turn.
    }
    return undefined;
  }
}

/**
 * What one Assignment of `mcp-tools` resolves to, including the server's
 * `serverEpoch`. A restart bumps the epoch, so this key changes, so the next
 * admitted Turn resolves a different mount and re-handshakes — while the
 * in-flight Turn, holding the client it already mounted, is untouched.
 */
export function mcpAssignmentResolutionV1(config: {
  assignment: { connectionId?: string };
  connection: { generation?: string; safeMetadata?: Record<string, unknown> };
}): string {
  const lifecycle = mcpConnectionLifecycleV1(config.connection);
  return mcpAssignmentResolutionKeyV1({
    connectionId: config.assignment.connectionId ?? "",
    ...(config.connection.generation === undefined
      ? {}
      : { connectionGeneration: config.connection.generation }),
    ...(lifecycle.serverEpoch === undefined
      ? {}
      : { serverEpoch: lifecycle.serverEpoch }),
  });
}

async function openAssignedCredential(
  config: McpRuntimeContributionConfig,
  connection: ConnectionView,
): Promise<string> {
  if (!config.leaseCredential) {
    throw new Error("MCP credential lease is unavailable");
  }
  const serialized = config.readSecret("CREDENTIAL_KEYRING");
  if (!serialized) throw new Error("Credential keyring is unavailable");
  const effectId = `mcp-mount:${connection.connectionId}:${
    config.randomId?.() ?? crypto.randomUUID()
  }`;
  const lease = await config.leaseCredential(effectId, connection.generation);
  try {
    if (
      lease.effectId !== effectId ||
      lease.connectionId !== connection.connectionId ||
      Date.parse(lease.expiresAt) <= (config.now ?? Date.now)()
    ) {
      throw new Error("MCP credential lease is invalid");
    }
    return await openCredentialV1({
      keyring: parseCredentialKeyringV1(serialized),
      context: {
        accountId: config.userId,
        connectionId: connection.connectionId,
        packageId: MCP_PACKAGE_ID,
        credentialGeneration: lease.credentialGeneration,
      },
      envelope: lease.envelope,
    });
  } finally {
    // The lease is a one-shot authorization to open the credential, not a
    // handle held for the life of the mount: it is settled the moment the key
    // is in hand, so an evicted Durable Object leaves nothing open.
    await (config.settleCredential?.(effectId) ?? Promise.resolve()).catch(
      () => undefined,
    );
  }
}

/** One tool's description, with the server's instructions attached to it. */
export function mcpToolDescriptionV1(input: {
  declaration: { name: string; description?: string };
  serverLabel: string;
  instructions?: string;
}): string {
  const base =
    input.declaration.description ??
    `${input.declaration.name} on the MCP server "${input.serverLabel}".`;
  return input.instructions
    ? `${base}\n\nInstructions for "${input.serverLabel}": ${input.instructions}`
    : base;
}

export function createMcpToolPlugin(config: {
  client: McpClient;
  serverSlug: string;
  serverLabel: string;
  tools: readonly McpToolDeclarationV1[];
  /**
   * GrokBot's `SetMcpInstructions`. There is no "tool set" in a model
   * request — `model/request.tools` is a flat list — so the instructions
   * become the description every one of this server's tools carries. That
   * puts them in the exact normalized request the session log records, which
   * is the only place a User can prove the model was told.
   */
  instructions?: string;
}): Plugin.Function {
  const plugin: Plugin.Function = (ctx: Context) => {
    const disposers = config.tools.map((declaration) => {
      const definition: ToolDefinition = {
        name: mcpToolNameV1(config.serverSlug, declaration.name),
        description: mcpToolDescriptionV1({
          declaration,
          serverLabel: config.serverLabel,
          ...(config.instructions ? { instructions: config.instructions } : {}),
        }),
        inputSchema: declaration.inputSchema,
        validate: (input: unknown) => input === undefined || isObject(input),
        execute: async (input: unknown) => {
          try {
            const result = await config.client.callTool(
              declaration.name,
              isObject(input) ? input : {},
            );
            return { content: result.content, isError: result.isError };
          } catch (error) {
            return {
              content:
                error instanceof Error ? error.message : "MCP tool call failed",
              isError: true,
            };
          }
        },
      };
      return ctx.tools.register(definition, {
        admissionCeiling: MCP_TOOL_TURN_TYPES,
      });
    });
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      void config.client.close();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}

export default createConfiguredMcpRuntimeContribution;
