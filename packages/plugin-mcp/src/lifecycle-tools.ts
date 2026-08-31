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
import type { ToolDefinition, TurnTypeV1 } from "@frockbot/kernel-contracts";
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

/** Adding a server is chat-only; every other lifecycle verb is not. */
export const MCP_ADMISSION_TURN_TYPES: readonly TurnTypeV1[] = ["chat"];

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
  const plugin: Plugin.Function = (ctx: Context) => {
    const disposers = definitions.map((definition) =>
      ctx.tools.register(definition, {
        admissionCeiling: MCP_LIFECYCLE_TURN_TYPES,
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}
