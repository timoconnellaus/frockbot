// The MCP runtime Contribution in workerd, against the stubbed endpoint.
//
// The unit tests hand the client a `fetch` of their own. This one does not:
// the Contribution falls back to the runtime's global `fetch`, which is the
// production path and the one that fails with "Illegal invocation" if the
// global is passed by reference rather than called. Only workerd shows that,
// which is why this test exists beside the unit suite.
import { describe, expect, test } from "vitest";
import type { ConnectionView } from "@frockbot/configuration-core";
import { createConfiguredMcpRuntimeContribution } from "@frockbot/plugin-mcp/agent";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import { MCP_ENDPOINT } from "./harness/miniflare.ts";

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    connectionId: "mcp-workerd-1",
    packageId: "mcp",
    connectionTypeId: "mcp-remote",
    displayName: "Example",
    state: "ready",
    generation: "generation-1",
    settings: { url: MCP_ENDPOINT, transport: "streamable-http" },
    safeMetadata: {},
    ...overrides,
  };
}

async function mount(view: ConnectionView, failures: string[]) {
  const plugin = await createConfiguredMcpRuntimeContribution({
    assignment: {
      packageId: "mcp",
      capabilityId: "mcp-tools",
      connectionId: view.connectionId,
      state: "enabled",
    },
    userId: "mcp-workerd-user",
    readSecret: () => undefined,
    authorizeConnection: () => Promise.resolve(view),
    onFailure: (reason) => failures.push(reason),
  });
  const root = new Context();
  await root.plugin(ToolRegistry);
  if (plugin) await root.plugin(plugin);
  return { root, mounted: plugin !== undefined };
}

describe("the MCP runtime Contribution in workerd", () => {
  test("handshakes over the runtime's own fetch and registers the server's tools", async () => {
    const failures: string[] = [];
    const { root, mounted } = await mount(connection(), failures);
    try {
      expect(failures).toEqual([]);
      expect(mounted).toBe(true);

      const schemas = root.tools.schemas({ turnType: "chat" });
      expect(schemas.map((schema) => schema.name)).toEqual([
        "mcp__example__echo",
      ]);
      // The server's own JSON Schema reaches the model unchanged.
      expect(schemas[0]!.inputSchema).toEqual({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      });

      const call = {
        id: "call-1",
        name: "mcp__example__echo",
        input: { message: "workerd" },
      };
      const prepared = await root.tools.prepare(call, {
        botId: "bot-1",
        agentId: "agent-1",
        sessionId: "session-1",
        compositionGenerationId: "generation-1",
        effectId: "effect-1",
        toolCall: call,
        turnType: "chat",
        signal: new AbortController().signal,
      });
      expect(prepared.kind).toBe("ready");
      const result = await root.tools.executePrepared(
        prepared as Extract<typeof prepared, { kind: "ready" }>,
        {
          botId: "bot-1",
          agentId: "agent-1",
          sessionId: "session-1",
          compositionGenerationId: "generation-1",
          effectId: "effect-1",
          toolCall: call,
          turnType: "chat",
          signal: new AbortController().signal,
        },
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual({
        echoed: { message: "workerd" },
      });
    } finally {
      await root.fiber.dispose();
    }
  });

  test("contributes no tool when the endpoint is unreachable", async () => {
    const failures: string[] = [];
    // Nothing but the two stubbed origins is allowed out of this Worker, so
    // an unknown host is refused at the outbound seam exactly as a private
    // address would be at ours.
    const { root, mounted } = await mount(
      connection({ settings: { url: "https://unreachable.example/mcp" } }),
      failures,
    );
    try {
      expect(mounted).toBe(false);
      expect(root.tools.schemas({ turnType: "chat" })).toEqual([]);
      expect(failures).toHaveLength(1);
    } finally {
      await root.fiber.dispose();
    }
  });
});
