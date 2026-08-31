/**
 * The MCP lifecycle as tools the Bot may use.
 *
 * GrokBot carries `GetMcpServerStatus`, `SetMcpInstructions` and
 * `RestartMcpServers` on every turn type, including automation, and strips
 * `AddMcpServer` from anything that is not a chat turn
 * (`AUTOMATION_PARENT_MEDIATED_MCP_TOOL_NAMES`). FrockBot says the same thing
 * with the machinery it already has: the `mcp-lifecycle` Capability's
 * manifest declares the ceiling, and `mcp_add_server` declares the narrower
 * chat-only admission inside it — adding a server is a User-shaped decision,
 * and an automation turn has no User in front of it.
 *
 * These tools need no Connection: they read and write the User's own MCP
 * records through the host the Bot's Durable Object supplies, which is why
 * this Contribution mounts for a Turn rather than for an Assignment.
 */
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
  TurnTypeV1,
} from "@frockbot/kernel-contracts";
import type { Context, Plugin } from "cordis";
import type {
  McpLifecycleReceiptV1,
  McpServerStatusViewV1,
} from "./records.js";
import { MAX_MCP_INSTRUCTIONS_BYTES_V1 } from "./records.js";

/** The manifest's admission ceiling for `mcp-lifecycle`, restated here. */
export const MCP_LIFECYCLE_TURN_TYPES: readonly TurnTypeV1[] = [
  "chat",
  "automation",
  "subagent",
  "channel",
];

/**
 * Adding a server, and asking the User to authorize one, are chat-only; every
 * other lifecycle verb is not. Both are User-shaped decisions, and an
 * automation, subagent or channel Turn has no User in front of it to make one.
 */
export const MCP_ADMISSION_TURN_TYPES: readonly TurnTypeV1[] = ["chat"];

/**
 * The open step a send belongs to. The session log is the reconstruction
 * surface, so a card recorded without its turn and step would not replay in
 * place. The same rule `plugin-shell` applies to `send_to_user`, restated here
 * because this Package records its own send rather than reaching into that one.
 */
function openStepPositionV1(
  session: Session,
  tool: string,
): { turn: number; step: number } {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error(`${tool} has no open step to record against`);
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error(`${tool} has no open step to record against`);
  }
  return { turn: started.turn, step: started.step };
}

/**
 * The User authority these tools run with. The Bot never reaches the records
 * itself: its Durable Object carries each call to the User Durable Object
 * that owns them, so a lifecycle tool has exactly the authority the User
 * already granted and no more.
 */
export interface McpLifecycleToolHostV1 {
  readStatus(): Promise<McpServerStatusViewV1>;
  execute(command: unknown): Promise<McpLifecycleReceiptV1>;
  /** Fresh command ids, so a retried tool call is one durable effect. */
  randomId?(): string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${field}" is required`);
  }
  return value;
}

function ok(value: unknown): { content: string; isError: boolean } {
  return { content: JSON.stringify(value), isError: false };
}

function failed(error: unknown): { content: string; isError: boolean } {
  return {
    content:
      error instanceof Error ? error.message : "MCP lifecycle call failed",
    isError: true,
  };
}

/**
 * A receipt is a result, never an exception: a refusal — a stdio server, a
 * quota breach — is exactly what the model needs to read back, and throwing
 * it away as an error would hide the reason.
 */
function receipt(value: McpLifecycleReceiptV1): {
  content: string;
  isError: boolean;
} {
  return {
    content: JSON.stringify(value),
    isError: value.status !== "applied",
  };
}

export function createMcpLifecycleRuntimePlugin(
  host: McpLifecycleToolHostV1,
): Plugin.Function {
  const nextId = () => host.randomId?.() ?? crypto.randomUUID();
  const definitions: ToolDefinition[] = [
    {
      name: "mcp_server_status",
      description:
        "List the User's MCP servers with their state (connecting, ready, needs-auth, error), tool count, last handshake, instructions, and any failure — plus the durable refusal ledger and the MCP quotas.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      idempotent: true,
      validate: (input) => input === undefined || isObject(input),
      execute: async () => {
        try {
          return ok(await host.readStatus());
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "mcp_set_instructions",
      description:
        "Set the instructions attached to one MCP server. They become the description every one of that server's tools carries in the next Turn's model request. An empty string clears them.",
      inputSchema: {
        type: "object",
        properties: {
          server_id: { type: "string" },
          instructions: {
            type: "string",
            maxLength: MAX_MCP_INSTRUCTIONS_BYTES_V1,
          },
        },
        required: ["server_id", "instructions"],
        additionalProperties: false,
      },
      validate: (input) => isObject(input),
      execute: async (input) => {
        try {
          const value = isObject(input) ? input : {};
          const instructions = value.instructions;
          if (typeof instructions !== "string") {
            throw new Error('"instructions" is required');
          }
          return receipt(
            await host.execute({
              schemaVersion: 1,
              type: "mcp/set-instructions",
              commandId: nextId(),
              serverId: text(value, "server_id"),
              instructions,
            }),
          );
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "mcp_restart_servers",
      description:
        "Restart one MCP server, or every one of them when no server is named. A restart bumps the server's epoch: the next admitted Turn re-handshakes and re-lists its tools, and the Turn in flight is unaffected.",
      inputSchema: {
        type: "object",
        properties: { server_id: { type: "string" } },
        additionalProperties: false,
      },
      validate: (input) => input === undefined || isObject(input),
      execute: async (input) => {
        try {
          const value = isObject(input) ? input : {};
          const named = value.server_id;
          const serverIds =
            typeof named === "string" && named.length > 0
              ? [named]
              : (await host.readStatus()).servers.map(
                  (server) => server.serverId,
                );
          const receipts: McpLifecycleReceiptV1[] = [];
          for (const serverId of serverIds) {
            receipts.push(
              await host.execute({
                schemaVersion: 1,
                type: "mcp/restart",
                commandId: nextId(),
                serverId,
              }),
            );
          }
          return {
            content: JSON.stringify({ restarted: receipts }),
            isError: receipts.some((value) => value.status !== "applied"),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "mcp_add_server",
      description:
        "Add a remote MCP server by URL. Chat turns only: adding a server is the User's decision and an automation turn has no User in front of it. stdio servers are refused durably — they need a bidirectional pipe on the User's Computer that FrockBot does not offer yet.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          url: { type: "string" },
          transport: {
            type: "string",
            enum: ["streamable-http", "sse", "stdio"],
          },
          api_key: { type: "string" },
          instructions: {
            type: "string",
            maxLength: MAX_MCP_INSTRUCTIONS_BYTES_V1,
          },
        },
        required: ["label", "url", "transport"],
        additionalProperties: false,
      },
      admission: { turnTypes: [...MCP_ADMISSION_TURN_TYPES] },
      validate: (input) => isObject(input),
      execute: async (input) => {
        try {
          const value = isObject(input) ? input : {};
          const apiKey = value.api_key;
          const instructions = value.instructions;
          return receipt(
            await host.execute({
              schemaVersion: 1,
              type: "mcp/add-server",
              commandId: nextId(),
              label: text(value, "label"),
              url: text(value, "url"),
              transport: text(value, "transport"),
              ...(typeof apiKey === "string" && apiKey.length > 0
                ? { apiKey }
                : {}),
              ...(typeof instructions === "string" && instructions.length > 0
                ? { instructions }
                : {}),
            }),
          );
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  definitions.push({
    name: "mcp_authenticate_server",
    description: [
      "Ask the User to authorize one OAuth MCP server that is not connected.",
      "This records a durable pending decision and shows the User a connect card.",
      "It returns no link and no token, and it grants nothing: only the User,",
      "pressing that card, can complete an authorization. Never write an",
      "authorization URL yourself — you cannot have one, and one you composed",
      "would not work. Chat turns only.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string" },
        reason: { type: "string", maxLength: 2_000 },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
    admission: { turnTypes: [...MCP_ADMISSION_TURN_TYPES] },
    validate: (input) => isObject(input),
    execute: async (input: unknown, context: ToolExecutionContext) => {
      try {
        const value = isObject(input) ? input : {};
        const serverId = text(value, "server_id");
        const status = await host.readStatus();
        const server = status.servers.find(
          (candidate) => candidate.serverId === serverId,
        );
        if (!server) {
          return {
            content: `No MCP server "${serverId}" is available.`,
            isError: true,
          };
        }
        const applied = await host.execute({
          schemaVersion: 1,
          type: "mcp/request-authorization",
          commandId: nextId(),
          serverId,
        });
        if (applied.status !== "applied") return receipt(applied);
        // The card is the User's, drawn by the host from the durable
        // projection. What the Bot supplies is a reason, never a link.
        const emitted = await emitConnectCard(context, {
          connectionId: serverId,
          title: `Connect ${server.label}`,
          ...(typeof value.reason === "string" && value.reason.length > 0
            ? { body: value.reason.slice(0, 2_000) }
            : {}),
        });
        return {
          content: JSON.stringify({
            ...applied,
            pendingAuthorization: true,
            cardShown: emitted,
          }),
          isError: false,
        };
      } catch (error) {
        return failed(error);
      }
    },
  });

  /**
   * Record the connect card on the durable session log, as a `send/to-user`
   * exactly like `send_to_user` produces — so the thread draws it, the
   * transcript replays it, and no second delivery path exists.
   */
  async function emitConnectCard(
    context: ToolExecutionContext,
    card: { connectionId: string; title: string; body?: string },
  ): Promise<boolean> {
    const session = sessionStore()?.get(context.sessionId);
    if (!session) return false;
    let position: { turn: number; step: number };
    try {
      position = openStepPositionV1(session, "mcp_authenticate_server");
    } catch {
      return false;
    }
    session.append({
      type: "send/to-user",
      ...position,
      occurrenceId: context.effectId,
      payload: { type: "connect-card", ...card },
    });
    await session.flush();
    return true;
  }

  let root: Context | undefined;

  /**
   * The Session store, if this root has one.
   *
   * Not an `inject`: these tools are the User's own MCP records and they work
   * with no Session at all — `mcp_server_status` is answered outside a Turn in
   * several tests and in the lifecycle surface. Only the connect card needs a
   * Session, and without one it degrades to "the decision was recorded, no card
   * was drawn" rather than costing the whole lifecycle its mount.
   */
  const sessionStore = (): Context["sessions"] | undefined => {
    try {
      return root?.sessions;
    } catch {
      return undefined;
    }
  };

  const plugin: Plugin.Function = (ctx: Context) => {
    root = ctx;
    const disposers = definitions.map((definition) =>
      ctx.tools.register(definition, {
        admissionCeiling: MCP_LIFECYCLE_TURN_TYPES,
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      root = undefined;
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}
