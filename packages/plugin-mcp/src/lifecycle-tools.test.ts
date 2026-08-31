import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { createMcpLifecycleRuntimePlugin } from "./lifecycle-tools.js";
import type {
  McpLifecycleReceiptV1,
  McpServerStatusViewV1,
} from "./records.js";

const STATUS: McpServerStatusViewV1 = {
  schemaVersion: 1,
  servers: [
    {
      schemaVersion: 1,
      serverId: "mcp-1",
      label: "Example",
      url: "https://mcp.example.test/mcp",
      transport: "streamable-http",
      serverEpoch: 1,
      state: "ready",
      toolCount: 1,
      toolsHash: "hash",
      lastHandshakeAt: "2026-08-31T00:00:00.000Z",
    },
  ],
  refusals: [],
  quotas: { maxServers: 16, maxToolsPerServer: 64, maxResponseBytes: 262_144 },
};

function context(options: {
  execute?(command: unknown): Promise<McpLifecycleReceiptV1>;
  status?: McpServerStatusViewV1;
}) {
  const commands: unknown[] = [];
  const root = new Context();
  let id = 0;
  const ready = (async () => {
    await root.plugin(ToolRegistry);
    await root.plugin(
      createMcpLifecycleRuntimePlugin({
        readStatus: () => Promise.resolve(options.status ?? STATUS),
        execute: (command) => {
          commands.push(command);
          return (
            options.execute?.(command) ??
            Promise.resolve({
              schemaVersion: 1,
              commandId: "applied",
              status: "applied",
            } satisfies McpLifecycleReceiptV1)
          );
        },
        randomId: () => `command-${++id}`,
      }),
    );
  })();
  return { root, commands, ready };
}

const CALL_CONTEXT = {
  botId: "bot-1",
  agentId: "agent-1",
  sessionId: "session-1",
  compositionGenerationId: "generation-1",
  effectId: "effect-1",
  signal: new AbortController().signal,
};

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

describe("the MCP lifecycle tools", () => {
  test("offers status, instructions and restart on every turn type", async () => {
    const { root, ready } = context({});
    await ready;
    for (const turnType of [
      "chat",
      "automation",
      "subagent",
      "channel",
    ] as const) {
      const names = root.tools.schemas({ turnType }).map((tool) => tool.name);
      expect(names).toContain("mcp_server_status");
      expect(names).toContain("mcp_set_instructions");
      expect(names).toContain("mcp_restart_servers");
    }
  });

  test("offers mcp_add_server on a chat turn and nowhere else", async () => {
    const { root, ready } = context({});
    await ready;
    expect(
      root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toContain("mcp_add_server");
    for (const turnType of ["automation", "subagent", "channel"] as const) {
      expect(
        root.tools.schemas({ turnType }).map((tool) => tool.name),
      ).not.toContain("mcp_add_server");
    }
  });

  test("mcp_server_status answers with the projection", async () => {
    const { root, ready } = context({});
    await ready;
    const result = await call(root, "mcp_server_status", {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(STATUS);
  });

  test("mcp_set_instructions sends one command carrying the text", async () => {
    const { root, commands, ready } = context({});
    await ready;
    const result = await call(root, "mcp_set_instructions", {
      server_id: "mcp-1",
      instructions: "Search first.",
    });
    expect(result.isError).toBe(false);
    expect(commands[0]).toMatchObject({
      type: "mcp/set-instructions",
      serverId: "mcp-1",
      instructions: "Search first.",
    });
  });

  test("mcp_restart_servers with no server restarts every one of them", async () => {
    const { root, commands, ready } = context({});
    await ready;
    await call(root, "mcp_restart_servers", {});
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "mcp/restart",
      serverId: "mcp-1",
    });
  });

  test("a refusal comes back as the receipt, not as a lost error", async () => {
    const { root, ready } = context({
      execute: () =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: "command-1",
          status: "refused",
          code: "unsupported-transport",
          failure: "stdio is not supported",
        }),
    });
    await ready;
    const result = await call(root, "mcp_add_server", {
      label: "Beeper",
      url: "stdio://beeper",
      transport: "stdio",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "refused",
      code: "unsupported-transport",
    });
  });

  test("mints a fresh command id per call, so a retry is one durable effect", async () => {
    const { root, commands, ready } = context({});
    await ready;
    await call(root, "mcp_restart_servers", { server_id: "mcp-1" });
    await call(root, "mcp_restart_servers", { server_id: "mcp-1" });
    expect(
      new Set(
        commands.map((command) => (command as { commandId: string }).commandId),
      ).size,
    ).toBe(2);
  });
});
