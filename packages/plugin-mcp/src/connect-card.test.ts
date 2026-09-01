/**
 * The connect card and the durable pending decision behind it.
 *
 * One rule holds these together and every test here is a restatement of it: a
 * Bot may record that its User needs to authorize something, and only the User
 * may authorize it. Nothing a Bot writes — the projection, the card payload,
 * the tool's own answer — may contain a link.
 */
import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { decodeSendToUserPayloadV1 } from "@frockbot/kernel-contracts";
import { decodePendingAuthorizationV1 } from "@frockbot/configuration-core";
import { createMcpLifecycleRuntimePlugin } from "./lifecycle-tools.js";
import { mcpPendingAuthorizationV1 } from "./records.js";
import type {
  McpLifecycleReceiptV1,
  McpServerRecordV1,
  McpServerStatusViewV1,
} from "./records.js";

const SERVER: McpServerRecordV1 = {
  schemaVersion: 1,
  serverId: "mcp-1",
  label: "OAuth Example",
  url: "https://mcp.example.test/mcp-oauth",
  transport: "streamable-http",
  serverEpoch: 1,
  state: "needs-auth",
  toolCount: 0,
  toolsHash: "",
  lastHandshakeAt: "2026-09-01T00:00:00.000Z",
  failure: {
    code: "unauthorized",
    message: "MCP server answered 401",
    at: "2026-09-01T00:00:00.000Z",
  },
};

const STATUS: McpServerStatusViewV1 = {
  schemaVersion: 1,
  servers: [SERVER],
  refusals: [],
  quotas: { maxServers: 16, maxToolsPerServer: 64, maxResponseBytes: 262_144 },
};

const CALL_CONTEXT = {
  botId: "bot-1",
  agentId: "agent-1",
  sessionId: "session-1",
  compositionGenerationId: "generation-1",
  effectId: "effect-1",
  signal: new AbortController().signal,
};

describe("the pending-authorization projection", () => {
  test("carries the reason, the moment, the Connection and its label — and no URL", () => {
    const pending = mcpPendingAuthorizationV1(SERVER, SERVER.lastHandshakeAt);
    expect(pending).toEqual({
      reason: "needs-auth",
      since: "2026-09-01T00:00:00.000Z",
      connectionId: "mcp-1",
      label: "OAuth Example",
    });
    // The server's own URL is in the record; it is not in the projection, and
    // neither is anything else that could be followed.
    expect(JSON.stringify(pending)).not.toContain("https://");
    expect(decodePendingAuthorizationV1(pending)).toEqual(pending);
  });

  test("is refused if anything tries to smuggle a redirect onto it", () => {
    expect(() =>
      decodePendingAuthorizationV1({
        ...mcpPendingAuthorizationV1(SERVER, SERVER.lastHandshakeAt),
        redirectUrl: "https://auth.example.test/authorize?code_challenge=x",
      }),
    ).toThrow();
  });
});

describe("the connect-card send payload", () => {
  test("decodes with a Connection, a title and a body, and nothing else", () => {
    const payload = decodeSendToUserPayloadV1({
      type: "connect-card",
      connectionId: "mcp-1",
      title: "Connect OAuth Example",
      body: "I need it to read your calendar.",
    });
    expect(payload).toEqual({
      type: "connect-card",
      connectionId: "mcp-1",
      title: "Connect OAuth Example",
      body: "I need it to read your calendar.",
    });
  });

  test("refuses a payload carrying a URL", () => {
    for (const extra of [
      { url: "https://auth.example.test/authorize" },
      { redirectUrl: "https://auth.example.test/authorize" },
      { href: "https://auth.example.test/authorize" },
    ]) {
      expect(() =>
        decodeSendToUserPayloadV1({
          type: "connect-card",
          connectionId: "mcp-1",
          title: "Connect",
          ...extra,
        }),
      ).toThrow(/unexpected key/);
    }
  });
});

function fixture(options: { status?: McpServerStatusViewV1 } = {}) {
  const commands: unknown[] = [];
  const appended: unknown[] = [];
  const session = {
    events: [{ type: "step/start", turn: 1, step: 1 }],
    append: (event: unknown) => {
      appended.push(event);
    },
    flush: () => Promise.resolve(),
  };
  const root = new Context();
  let id = 0;
  const ready = (async () => {
    await root.plugin(ToolRegistry);
    // The Session store the Agent loop provides. Registered as a service so
    // the lifecycle Plugin finds it exactly as it does in a real Turn.
    root.provide("sessions");
    root.sessions = { get: () => session } as never;
    await root.plugin(
      createMcpLifecycleRuntimePlugin({
        readStatus: () => Promise.resolve(options.status ?? STATUS),
        execute: (command) => {
          commands.push(command);
          return Promise.resolve({
            schemaVersion: 1,
            commandId: "applied",
            status: "applied",
            serverId: "mcp-1",
          } satisfies McpLifecycleReceiptV1);
        },
        randomId: () => `command-${++id}`,
      }),
    );
  })();
  return { root, commands, appended, ready };
}

async function call(
  root: Context,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  const toolCall = { id: "call-1", name, input };
  const prepared = await root.tools.prepare(toolCall, {
    ...CALL_CONTEXT,
    toolCall,
    turnType: "chat" as const,
  });
  if (prepared.kind !== "ready") return prepared.result;
  return root.tools.executePrepared(prepared, {
    ...CALL_CONTEXT,
    toolCall,
    turnType: "chat" as const,
  });
}

describe("mcp_authenticate_server", () => {
  test("is offered on a chat turn and nowhere else", async () => {
    const { root, ready } = fixture();
    await ready;
    expect(
      root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toContain("mcp_authenticate_server");
    for (const turnType of ["automation", "subagent"] as const) {
      expect(
        root.tools.schemas({ turnType }).map((tool) => tool.name),
      ).not.toContain("mcp_authenticate_server");
    }
  });

  test("records a durable pending decision and emits a card with no URL", async () => {
    const { root, commands, appended, ready } = fixture();
    await ready;

    const result = await call(root, "mcp_authenticate_server", {
      server_id: "mcp-1",
      reason: "I need it to read your calendar.",
    });

    expect(result.isError).toBe(false);
    expect(commands).toEqual([
      {
        schemaVersion: 1,
        type: "mcp/request-authorization",
        commandId: "command-1",
        serverId: "mcp-1",
      },
    ]);
    expect(appended).toHaveLength(1);
    const event = appended[0] as { type: string; payload: unknown };
    expect(event.type).toBe("send/to-user");
    expect(decodeSendToUserPayloadV1(event.payload)).toEqual({
      type: "connect-card",
      connectionId: "mcp-1",
      title: "Connect OAuth Example",
      body: "I need it to read your calendar.",
    });
    // Not the tool's answer, not the card: no link anywhere the Bot can see.
    expect(JSON.stringify(event.payload)).not.toContain("http");
    expect(result.content).not.toContain("http");
  });

  test("says so rather than inventing a server it was not given", async () => {
    const { root, commands, ready } = fixture();
    await ready;
    const result = await call(root, "mcp_authenticate_server", {
      server_id: "mcp-missing",
    });
    expect(result.isError).toBe(true);
    expect(commands).toEqual([]);
  });
});
