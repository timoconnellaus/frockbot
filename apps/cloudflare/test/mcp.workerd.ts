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
import { META_TOOL_NAMES_V1, metaOnlyToolNamesV1 } from "./dynamic-tools.ts";
import {
  MCP_ENDPOINT,
  MCP_HANDSHAKE_COUNT_ENDPOINT,
  MCP_UNREACHABLE_ENDPOINT,
} from "./harness/miniflare.ts";
import {
  mcpCapabilityResolutionV1,
  type McpMountOutcomeV1,
} from "@frockbot/plugin-mcp/agent";

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

async function handshakes(): Promise<number> {
  const response = await fetch(MCP_HANDSHAKE_COUNT_ENDPOINT);
  return ((await response.json()) as { handshakes: number }).handshakes;
}

async function mount(
  view: ConnectionView,
  failures: string[],
  outcomes: McpMountOutcomeV1[] = [],
) {
  const plugin = await createConfiguredMcpRuntimeContribution({
    capability: {
      packageId: "mcp",
      capabilityId: "mcp-tools",
      connectionId: view.connectionId,
    },
    userId: "mcp-workerd-user",
    readSecret: () => undefined,
    authorizeConnection: () => Promise.resolve(view),
    onFailure: (reason) => failures.push(reason),
    onOutcome: (outcome) => {
      outcomes.push(outcome);
    },
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
      // An MCP tool is native — it carries no namespace — so it is still
      // offered by name, now beside the two meta-tools every registry
      // contributes (ADR 0021).
      expect(schemas.map((schema) => schema.name)).toEqual([
        "mcp__example__echo",
        ...META_TOOL_NAMES_V1,
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
      // No MCP tool at all: what is left is exactly the meta-tools.
      expect(
        root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
      ).toEqual(metaOnlyToolNamesV1());
      expect(failures).toHaveLength(1);
    } finally {
      await root.fiber.dispose();
    }
  });

  test("a restart makes the next mount handshake again, and the one in flight does not", async () => {
    // A restart is a `serverEpoch` bump on the durable record, mirrored onto
    // the Connection. Nothing is killed: the Turn already holding a client
    // keeps it, and the *next* resolution is a different one, so it
    // handshakes and re-lists.
    const before = connection({ safeMetadata: { serverEpoch: 1 } });
    const after = connection({ safeMetadata: { serverEpoch: 2 } });
    expect(
      mcpCapabilityResolutionV1({
        capability: { connectionId: before.connectionId },
        connection: after,
      }),
    ).not.toBe(
      mcpCapabilityResolutionV1({
        capability: { connectionId: before.connectionId },
        connection: before,
      }),
    );

    const start = await handshakes();
    const inFlight = await mount(before, []);
    try {
      expect(await handshakes()).toBe(start + 1);
      // The restarted resolution mounts its own client against the real
      // endpoint rather than reusing the resident one.
      const next = await mount(after, []);
      try {
        expect(await handshakes()).toBe(start + 2);
        expect(
          next.root.tools
            .schemas({ turnType: "chat" })
            .map((tool) => tool.name),
        ).toEqual(["mcp__example__echo", ...META_TOOL_NAMES_V1]);
        // The Turn that was already running still has its tools.
        expect(
          inFlight.root.tools
            .schemas({ turnType: "chat" })
            .map((tool) => tool.name),
        ).toEqual(["mcp__example__echo", ...META_TOOL_NAMES_V1]);
      } finally {
        await next.root.fiber.dispose();
      }
    } finally {
      await inFlight.root.fiber.dispose();
    }
  });

  test("reports the durable outcome of a mount that reaches a broken server", async () => {
    const failures: string[] = [];
    const outcomes: McpMountOutcomeV1[] = [];
    const { root, mounted } = await mount(
      connection({
        settings: { url: MCP_UNREACHABLE_ENDPOINT },
        safeMetadata: { serverEpoch: 3 },
      }),
      failures,
      outcomes,
    );
    try {
      expect(mounted).toBe(false);
      expect(outcomes[0]).toMatchObject({
        connectionId: "mcp-workerd-1",
        serverEpoch: 3,
        state: "error",
        failure: { code: "unreachable" },
      });
    } finally {
      await root.fiber.dispose();
    }
  });
});
