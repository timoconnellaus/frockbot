import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import {
  createConfiguredMcpRuntimeContribution,
  decodeMcpConnectionSettingsV1,
  MAX_MCP_SERVERS_PER_USER_V1,
  mcpAssignmentResolutionV1,
  mcpConnectionLifecycleV1,
  mcpServerSlugV1,
  mcpToolNameV1,
} from "./agent.js";

const roots: Context[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "Example" },
};

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    connectionId: "mcp-1",
    packageId: "mcp",
    connectionTypeId: "mcp-remote",
    displayName: "Example",
    state: "ready",
    generation: "gen-1",
    settings: { url: "https://mcp.example.test/mcp" },
    safeMetadata: {},
    ...overrides,
  };
}

function server(options: {
  tools?: { name: string; inputSchema?: Record<string, unknown> }[];
  onCall?: (name: string, args: unknown) => unknown;
  calls?: { name: string; args: unknown }[];
}): typeof fetch {
  const tools = options.tools ?? [
    {
      name: "echo",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
  ];
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.id === undefined) return new Response("", { status: 202 });
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: INITIALIZE_RESULT,
      });
    }
    if (body.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            inputSchema: tool.inputSchema ?? { type: "object" },
          })),
        },
      });
    }
    const params = body.params as { name: string; arguments: unknown };
    options.calls?.push({ name: params.name, args: params.arguments });
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              options.onCall?.(params.name, params.arguments) ?? { ok: true },
            ),
          },
        ],
      },
    });
  }) as typeof fetch;
}

async function mount(config: {
  fetch: typeof fetch;
  connection?: ConnectionView;
  assignmentIndex?: number;
  failures?: string[];
  outcomes?: unknown[];
}): Promise<{ root: Context; mounted: boolean }> {
  const plugin = await createConfiguredMcpRuntimeContribution({
    assignment: {
      packageId: "mcp",
      capabilityId: "mcp-tools",
      connectionId: "mcp-1",
      state: "enabled",
    },
    ...(config.assignmentIndex === undefined
      ? {}
      : { assignmentIndex: config.assignmentIndex }),
    userId: "user-1",
    readSecret: () => undefined,
    authorizeConnection: () =>
      Promise.resolve(config.connection ?? connection()),
    fetch: config.fetch,
    onFailure: (reason) => config.failures?.push(reason),
    ...(config.outcomes
      ? {
          onOutcome: (outcome) => {
            config.outcomes!.push(outcome);
          },
        }
      : {}),
  });
  const root = new Context();
  roots.push(root);
  await root.plugin(ToolRegistry);
  if (plugin) await root.plugin(plugin);
  return { root, mounted: plugin !== undefined };
}

describe("tool naming", () => {
  test("mangles the server label and the server's own tool name", () => {
    expect(
      mcpServerSlugV1({ connectionId: "mcp-1", displayName: "Example" }),
    ).toBe("example");
    expect(
      mcpServerSlugV1({ connectionId: "mcp-1", displayName: "My Docs (v2)!" }),
    ).toBe("my_docs_v2");
    // An unlabelled Connection still yields a stable, legal segment.
    expect(mcpServerSlugV1({ connectionId: "mcp-a.b", displayName: "" })).toBe(
      "mcp_a_b",
    );
    expect(mcpToolNameV1("example", "echo")).toBe("mcp__example__echo");
    expect(mcpToolNameV1("example", "search/files")).toBe(
      "mcp__example__search_files",
    );
  });
});

describe("Connection-scoped settings", () => {
  test("defaults the transport and the key header", () => {
    const settings = decodeMcpConnectionSettingsV1({
      url: "https://mcp.example.test/mcp",
    });
    expect(settings.transport).toBe("streamable-http");
    expect(settings.headerName).toBe("Authorization");
    expect(settings.url.toString()).toBe("https://mcp.example.test/mcp");
  });

  test("refuses an unsupported transport and a stdio server", () => {
    expect(() =>
      decodeMcpConnectionSettingsV1({
        url: "https://mcp.example.test/mcp",
        transport: "stdio",
      }),
    ).toThrow(/transport is unsupported/);
  });
});

describe("mounting one Assignment", () => {
  test("registers every listed tool with the server's own schema", async () => {
    const { root } = await mount({ fetch: server({}) });

    const schemas = root.tools.schemas({ turnType: "chat" });

    expect(schemas.map((schema) => schema.name)).toEqual([
      "mcp__example__echo",
    ]);
    expect(schemas[0]!.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  test("offers its tools on every turn type the manifest admits", async () => {
    const { root } = await mount({ fetch: server({}) });

    for (const turnType of ["chat", "automation", "subagent"] as const) {
      expect(root.tools.schemas({ turnType }).map((tool) => tool.name)).toEqual(
        ["mcp__example__echo"],
      );
    }
  });

  test("calls the server's tool by its unmangled name", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const { root } = await mount({
      fetch: server({ calls, onCall: (_name, args) => ({ echoed: args }) }),
    });

    const prepared = await root.tools.prepare(
      { id: "call-1", name: "mcp__example__echo", input: { message: "hi" } },
      context(),
    );
    expect(prepared.kind).toBe("ready");
    const result = await root.tools.executePrepared(
      prepared as Extract<typeof prepared, { kind: "ready" }>,
      context(),
    );

    expect(calls).toEqual([{ name: "echo", args: { message: "hi" } }]);
    expect(result).toEqual({
      content: JSON.stringify({ echoed: { message: "hi" } }),
      isError: false,
    });
  });

  test("reports a failing call as an error the Bot can read", async () => {
    const { root } = await mount({
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.id === undefined) return new Response("", { status: 202 });
        if (body.method === "tools/call") {
          return new Response("boom", { status: 503 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? INITIALIZE_RESULT
              : { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
        });
      }) as typeof fetch,
    });

    const prepared = await root.tools.prepare(
      { id: "call-1", name: "mcp__example__echo", input: {} },
      context(),
    );
    const result = await root.tools.executePrepared(
      prepared as Extract<typeof prepared, { kind: "ready" }>,
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("503");
  });

  test("contributes nothing when the handshake fails, with a reason", async () => {
    const failures: string[] = [];
    const { root, mounted } = await mount({
      failures,
      fetch: (() =>
        Promise.resolve(
          new Response("Unauthorized", { status: 401 }),
        )) as unknown as typeof fetch,
    });

    expect(mounted).toBe(false);
    expect(root.tools.schemas({ turnType: "chat" })).toEqual([]);
    expect(failures[0]).toContain("401");
  });

  test("refuses a Connection whose URL names a private address", async () => {
    const failures: string[] = [];
    const { mounted } = await mount({
      failures,
      fetch: server({}),
      connection: connection({
        settings: { url: "https://192.168.1.10/mcp" },
      }),
    });

    expect(mounted).toBe(false);
    expect(failures[0]).toContain("private address");
  });

  test("refuses past the per-User server ceiling", async () => {
    const failures: string[] = [];
    const { mounted } = await mount({
      failures,
      fetch: server({}),
      assignmentIndex: MAX_MCP_SERVERS_PER_USER_V1,
    });

    expect(mounted).toBe(false);
    expect(failures[0]).toContain(String(MAX_MCP_SERVERS_PER_USER_V1));
  });

  test("refuses a Connection that is not ready", async () => {
    const failures: string[] = [];
    const { mounted } = await mount({
      failures,
      fetch: server({}),
      connection: connection({ state: "failed" }),
    });

    expect(mounted).toBe(false);
    expect(failures[0]).toContain("not ready");
  });
});

function context() {
  return {
    botId: "bot-1",
    agentId: "agent-1",
    sessionId: "session-1",
    compositionGenerationId: "generation-1",
    effectId: "effect-1",
    turnType: "chat" as const,
    signal: new AbortController().signal,
  };
}

describe("the durable lifecycle a mount participates in", () => {
  test("attaches the server's instructions to every one of its tool descriptions", async () => {
    const { root } = await mount({
      fetch: server({ tools: [{ name: "echo" }] }),
      connection: connection({
        safeMetadata: {
          serverEpoch: 4,
          instructions: "Search before answering.",
        },
      }),
    });

    const [schema] = root.tools.schemas({ turnType: "chat" });
    expect(schema?.name).toBe("mcp__example__echo");
    // The instructions reach the model in the exact normalized request the
    // session log records, which is the only place a User can prove it.
    expect(schema?.description).toContain("Search before answering.");
  });

  test("reports a ready mount and an unreachable one, with the epoch it ran at", async () => {
    const ready: unknown[] = [];
    await mount({
      fetch: server({}),
      connection: connection({ safeMetadata: { serverEpoch: 4 } }),
      outcomes: ready,
    });
    expect(ready[0]).toMatchObject({
      connectionId: "mcp-1",
      serverEpoch: 4,
      state: "ready",
      protocolVersion: "2025-06-18",
    });

    const broken: unknown[] = [];
    const failures: string[] = [];
    const { mounted } = await mount({
      fetch: (() =>
        Promise.resolve(
          new Response("gone", { status: 503 }),
        )) as unknown as typeof fetch,
      connection: connection({ safeMetadata: { serverEpoch: 4 } }),
      outcomes: broken,
      failures,
    });
    expect(mounted).toBe(false);
    expect(broken[0]).toMatchObject({
      connectionId: "mcp-1",
      serverEpoch: 4,
      state: "error",
      failure: { code: "unreachable" },
    });
    expect(failures[0]).toContain("503");
  });

  test("reports needs-auth when the server refuses the credential", async () => {
    const outcomes: unknown[] = [];
    await mount({
      fetch: (() =>
        Promise.resolve(
          new Response("Unauthorized", { status: 401 }),
        )) as unknown as typeof fetch,
      outcomes,
    });
    expect(outcomes[0]).toMatchObject({
      state: "needs-auth",
      failure: { code: "unauthorized" },
    });
  });

  test("the Assignment's resolution key moves with the server epoch", () => {
    const before = mcpAssignmentResolutionV1({
      assignment: { connectionId: "mcp-1" },
      connection: connection({ safeMetadata: { serverEpoch: 1 } }),
    });
    const restarted = mcpAssignmentResolutionV1({
      assignment: { connectionId: "mcp-1" },
      connection: connection({ safeMetadata: { serverEpoch: 2 } }),
    });
    expect(restarted).not.toBe(before);
  });

  test("reads no epoch or instructions from a Connection that carries none", () => {
    expect(mcpConnectionLifecycleV1({ safeMetadata: {} })).toEqual({});
    // A Bot cannot smuggle a lifecycle field in as the wrong type.
    expect(
      mcpConnectionLifecycleV1({
        safeMetadata: { serverEpoch: "4", instructions: 7 },
      }),
    ).toEqual({});
  });
});
