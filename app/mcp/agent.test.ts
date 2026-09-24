import { describe, expect, test } from "bun:test";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import type { ToolCall, ToolExecutionContext } from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type { ConnectionView } from "@frockbot/core/configuration";
import { createConfiguredMcpRuntimeContributionV1 } from "./agent.js";
import { createFakeMcpServerV1, type FakeMcpToolV1 } from "./testing.js";
import type { McpFetchV1 } from "./client.js";
import { encodeMcpAccessSecretV1 } from "./oauth.js";

const echo: FakeMcpToolV1 = {
  name: "echo",
  description: "Say it back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
  },
  run: (args) => ({
    content: [{ type: "text", text: `echo: ${String(args.message)}` }],
  }),
};

const broken: FakeMcpToolV1 = {
  name: "broken",
  description: "Always fails.",
  run: () => ({
    content: [{ type: "text", text: "the widget is jammed" }],
    isError: true,
  }),
};

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "mcp",
    connectionTypeId: "mcp-server",
    displayName: "Example",
    state: "ready",
    generation: "g1",
    settings: { url: "https://mcp.example.test/mcp" },
    authorization: {
      schemaVersion: 1,
      kind: "none",
      credential: {
        schemaVersion: 1,
        configured: false,
        source: "none",
        writable: false,
      },
    },
    safeMetadata: {
      namespace: "mcp-example",
      host: "mcp.example.test",
      startedAt: "2026-09-24T00:00:00.000Z",
      transport: "streamable-http",
      instructions: "Echo repeats what it is told.",
    },
    ...overrides,
  };
}

const CAPABILITY = {
  packageId: "mcp",
  capabilityId: "mcp-tools",
  connectionId: "connection-1",
};

function context(effectId = "tool:1:1:0"): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "bot",
    sessionId: "session",
    compositionGenerationId: "generation",
    effectId,
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

function call(
  toolName: string,
  args: unknown,
  withDetails = true,
  namespace = "mcp-example",
): ToolCall {
  return {
    id: "call-1",
    name: "call_dynamic_tool",
    input: {
      namespace,
      toolName,
      arguments: args,
      ...(withDetails
        ? { mcpDetails: { description: "Checking the server works" } }
        : {}),
    },
  };
}

async function mount(
  options: {
    connection?: ConnectionView;
    token?: string;
    fetch?: (server: ReturnType<typeof createFakeMcpServerV1>) => McpFetchV1;
    permit?: () => Promise<boolean>;
    pinned?: Map<string, unknown>;
    /** What the lease opens to, when it is not the token itself. */
    secret?: string;
  } = {},
) {
  const server = createFakeMcpServerV1({
    tools: [echo, broken],
    ...(options.token ? { token: options.token } : {}),
  });
  const leases: string[] = [];
  const settled: string[] = [];
  const catalogReads: (string | undefined)[] = [];
  const root = createAgentRuntimeHarness();
  const target = options.connection ?? connection();
  Object.assign(root, {
    credentials: {
      open: async (input: { lease: CredentialLeaseV1 }) => {
        expect(input.lease.connectionId).toBe(target.connectionId);
        return options.secret ?? options.token ?? "";
      },
    },
  });
  const feature = createConfiguredMcpRuntimeContributionV1({
    capability: CAPABILITY,
    userId: "tim",
    connection: target,
    fetch: options.fetch ? options.fetch(server) : server.fetch,
    readCatalog: async (toolName) => {
      catalogReads.push(toolName);
      const tools = server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      }));
      if (toolName === undefined) {
        return {
          kind: "directory",
          tools: tools.map(({ name, description }) => ({ name, description })),
        };
      }
      const tool = tools.find((candidate) => candidate.name === toolName);
      return tool
        ? { kind: "tool", tool }
        : {
            kind: "unavailable",
            message: `This server has no tool named "${toolName}".`,
          };
    },
    ...(options.pinned
      ? {
          pinToolCatalog: async (pinId, read) => {
            const existing = options.pinned!.get(pinId);
            if (existing !== undefined) return existing;
            const value = await read();
            options.pinned!.set(pinId, value);
            return value;
          },
        }
      : {}),
    ...(options.permit ? { permitConnection: options.permit } : {}),
    leaseCredential: async (effectId, generation) => {
      leases.push(effectId);
      return {
        schemaVersion: 1,
        leaseId: "lease-1",
        effectId,
        connectionId: target.connectionId,
        credentialGeneration: generation ?? "",
        expiresAt: "2099-01-01T00:00:00.000Z",
        envelope: {} as CredentialLeaseV1["envelope"],
      };
    },
    settleCredential: async (effectId) => {
      settled.push(effectId);
    },
  });
  if (feature) await root.mount(feature);
  const run = async (c: ToolCall) => {
    const prepared = await root.tools.prepare(c, context());
    if (prepared.kind === "denied") return prepared.result;
    return root.tools.executePrepared(prepared, context());
  };
  return { root, server, feature, run, leases, settled, catalogReads };
}

describe("an MCP server in a Bot's Turn", () => {
  test("mounts nothing for a server that is not ready or not this Package's", async () => {
    expect(
      (await mount({ connection: connection({ state: "failed" }) })).feature,
    ).toBeUndefined();
    expect(
      (await mount({ connection: connection({ packageId: "connect" }) }))
        .feature,
    ).toBeUndefined();
    expect(
      (await mount({ connection: connection({ settings: {} }) })).feature,
    ).toBeUndefined();
  });

  test("lists its tools from the User's copy and calls the server only to run one", async () => {
    const { root, server, run } = await mount();
    const listed = await run({
      id: "list",
      name: "get_dynamic_tools",
      input: { namespace: "mcp-example" },
    });
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("echo");
    expect(server.calls).toEqual([]);
    const result = await run(call("echo", { message: "hi" }));
    expect(result).toEqual({ content: "echo: hi", isError: false });
    expect(server.calls).toEqual([{ name: "echo", args: { message: "hi" } }]);
    await root.dispose();
  });

  test("is external: a call must say why it is being made", async () => {
    const { root, server, run } = await mount();
    const refused = await run(call("echo", { message: "hi" }, false));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("mcpDetails.description");
    expect(server.calls).toEqual([]);
    await root.dispose();
  });

  test("leases the token for the one call and settles it", async () => {
    const withToken = connection({
      authorization: {
        schemaVersion: 1,
        kind: "api-key",
        credential: {
          schemaVersion: 1,
          configured: true,
          source: "api-key",
          writable: true,
          generation: "g1",
        },
      },
    });
    const { root, server, run, leases, settled } = await mount({
      connection: withToken,
      token: "sk-secret",
    });
    expect(await run(call("echo", { message: "hi" }))).toEqual({
      content: "echo: hi",
      isError: false,
    });
    expect(leases).toEqual(["tool:1:1:0"]);
    expect(settled).toEqual(["tool:1:1:0"]);
    expect(new Set(server.authorizations)).toEqual(
      new Set(["Bearer sk-secret"]),
    );
    await root.dispose();
  });

  test("sends a signed-in server the access token its lease holds", async () => {
    const signedIn = connection({
      authorization: {
        schemaVersion: 1,
        kind: "grant",
        credential: {
          schemaVersion: 1,
          configured: true,
          source: "grant",
          writable: true,
          generation: "g1",
        },
      },
    });
    const { root, server, run, leases, settled } = await mount({
      connection: signedIn,
      token: "access-1",
      secret: encodeMcpAccessSecretV1({
        accessToken: "access-1",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      }),
    });
    expect(await run(call("echo", { message: "hi" }))).toEqual({
      content: "echo: hi",
      isError: false,
    });
    expect(leases).toEqual(["tool:1:1:0"]);
    expect(settled).toEqual(["tool:1:1:0"]);
    expect(new Set(server.authorizations)).toEqual(
      new Set(["Bearer access-1"]),
    );
    await root.dispose();
  });

  test("says what the server said when a tool fails", async () => {
    const { root, run } = await mount();
    expect(await run(call("broken", {}))).toEqual({
      content: "The server reported an error: the widget is jammed",
      isError: true,
    });
    await root.dispose();
  });

  test("a server it cannot reach was never asked", async () => {
    const { root, run } = await mount({
      fetch: () => async () => new Response("down", { status: 503 }),
    });
    const result = await run(call("echo", { message: "hi" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("was not sent");
    await root.dispose();
  });

  test("a call lost after it left is an unknown outcome, not a retry", async () => {
    const { root, run } = await mount({
      fetch: (server) => async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes('"tools/call"')) {
          throw new TypeError("network connection lost");
        }
        return server.fetch(input, init);
      },
    });
    const result = await run(call("echo", { message: "hi" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Do not repeat it");
    await root.dispose();
  });

  test("a server removed since the Turn was admitted is refused before the call", async () => {
    const { root, server, run } = await mount({ permit: async () => false });
    const result = await run(call("echo", { message: "hi" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("stale-contract");
    expect(server.calls).toEqual([]);
    await root.dispose();
  });

  test("pins each tool's schema for the Turn so a remount keeps it", async () => {
    const pinned = new Map<string, unknown>();
    const first = await mount({ pinned });
    await first.run({
      id: "read",
      name: "get_dynamic_tools",
      input: { namespace: "mcp-example", toolName: "echo" },
    });
    expect([...pinned.keys()]).toEqual(["connection-1/echo"]);
    await first.root.dispose();
    const second = await mount({ pinned });
    await second.run(call("echo", { message: "again" }));
    // The remount read the directory, never the tool: the pin answered it.
    expect(second.catalogReads).toEqual([undefined]);
    await second.root.dispose();
  });
});
