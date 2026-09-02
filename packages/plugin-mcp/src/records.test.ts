import { describe, expect, test } from "bun:test";
import { McpProtocolError } from "./mcp-client.js";
import {
  decodeMcpLifecycleCommandV1,
  decodeMcpLifecycleReceiptV1,
  decodeMcpMountOutcomeV1,
  decodeMcpRefusalRecordV1,
  decodeMcpServerRecordV1,
  decodeMcpServerStatusViewV1,
  mcpConnectionResolutionKeyV1,
  mcpConnectionMetadataV1,
  mcpFailureCodeV1,
  type McpServerRecordV1,
} from "./records.js";

function server(
  overrides: Partial<McpServerRecordV1> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    serverId: "mcp-1",
    label: "Example",
    url: "https://mcp.example.test/mcp",
    transport: "streamable-http",
    serverEpoch: 1,
    state: "ready",
    toolCount: 2,
    toolsHash: "abc123",
    lastHandshakeAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("the durable MCP server record", () => {
  test("decodes a complete record and drops nothing", () => {
    const decoded = decodeMcpServerRecordV1(
      server({
        instructions: "Prefer the search tool.",
        protocolVersion: "2025-06-18",
        state: "needs-auth",
        failure: {
          code: "unauthorized",
          message: "MCP server answered 401",
          at: "2026-08-31T00:00:01.000Z",
        },
      }),
    );
    expect(decoded.state).toBe("needs-auth");
    expect(decoded.instructions).toBe("Prefer the search tool.");
    expect(decoded.failure?.code).toBe("unauthorized");
  });

  test("refuses an unknown field rather than ignoring it", () => {
    expect(() => decodeMcpServerRecordV1({ ...server(), pid: 1234 })).toThrow(
      'MCP server record carries unknown field "pid"',
    );
  });

  test("refuses a state, transport, failure code or version it does not know", () => {
    expect(() =>
      decodeMcpServerRecordV1(server({ state: "stopped" as never })),
    ).toThrow("MCP server record state is invalid");
    expect(() =>
      decodeMcpServerRecordV1(server({ transport: "stdio" as never })),
    ).toThrow("MCP server record transport is invalid");
    expect(() =>
      decodeMcpServerRecordV1(
        server({
          failure: { code: "boom", message: "x", at: "2026-08-31" } as never,
        }),
      ),
    ).toThrow("MCP server failure code is invalid");
    expect(() =>
      decodeMcpServerRecordV1({ ...server(), schemaVersion: 2 }),
    ).toThrow("MCP server record schemaVersion is unsupported");
  });

  test("accepts an empty tools hash, which is a server that has not listed yet", () => {
    expect(
      decodeMcpServerRecordV1(server({ state: "connecting", toolsHash: "" }))
        .toolsHash,
    ).toBe("");
  });

  test("projects only the fields the Bot needs onto the Connection", () => {
    const metadata = mcpConnectionMetadataV1(
      decodeMcpServerRecordV1(
        server({ instructions: "Be brief.", protocolVersion: "2025-06-18" }),
      ),
    );
    expect(metadata).toEqual({
      serverEpoch: 1,
      serverState: "ready",
      toolCount: 2,
      toolsHash: "abc123",
      protocolVersion: "2025-06-18",
      instructions: "Be brief.",
    });
    // Nothing that could be a credential, and nothing the Bot cannot use.
    expect(Object.keys(metadata)).not.toContain("url");
  });
});

describe("the refusal ledger and the status projection", () => {
  test("decodes a refusal with its origin", () => {
    const refusal = decodeMcpRefusalRecordV1({
      schemaVersion: 1,
      refusalId: "r-1",
      commandId: "add-1",
      code: "unsupported-transport",
      message: "stdio is not supported",
      at: "2026-08-31T00:00:00.000Z",
      label: "Beeper",
      url: "stdio://beeper",
      transport: "stdio",
    });
    expect(refusal.transport).toBe("stdio");
  });

  test("refuses a transport the refusal ledger does not know", () => {
    expect(() =>
      decodeMcpRefusalRecordV1({
        schemaVersion: 1,
        refusalId: "r-1",
        commandId: "add-1",
        code: "server-quota",
        message: "too many",
        at: "2026-08-31T00:00:00.000Z",
        transport: "pipe",
      }),
    ).toThrow("MCP refusal transport is invalid");
  });

  test("round-trips a status view", () => {
    const view = decodeMcpServerStatusViewV1({
      schemaVersion: 1,
      servers: [server()],
      refusals: [],
      quotas: {
        maxServers: 16,
        maxToolsPerServer: 64,
        maxResponseBytes: 262_144,
      },
    });
    expect(view.servers).toHaveLength(1);
    expect(view.quotas.maxServers).toBe(16);
    expect(() =>
      decodeMcpServerStatusViewV1({
        schemaVersion: 1,
        servers: [],
        refusals: [],
        quotas: { maxServers: 16, maxToolsPerServer: 64 },
      }),
    ).toThrow("maxResponseBytes is invalid");
  });
});

describe("the lifecycle command codec", () => {
  test("decodes each command exactly", () => {
    expect(
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/add-server",
        commandId: "add-1",
        label: "Example",
        url: "https://mcp.example.test/mcp",
        transport: "streamable-http",
      }).type,
    ).toBe("mcp/add-server");
    expect(
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/set-instructions",
        commandId: "set-1",
        serverId: "mcp-1",
        instructions: "",
      }),
    ).toMatchObject({ instructions: "" });
    expect(
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/restart",
        commandId: "restart-1",
        serverId: "mcp-1",
      }).type,
    ).toBe("mcp/restart");
  });

  test("carries stdio through the codec so the refusal can be durable", () => {
    const command = decodeMcpLifecycleCommandV1({
      schemaVersion: 1,
      type: "mcp/add-server",
      commandId: "add-1",
      label: "Beeper",
      url: "stdio://beeper",
      transport: "stdio",
    });
    expect(command).toMatchObject({ transport: "stdio" });
  });

  test("refuses unknown fields, unknown types and an unknown transport", () => {
    expect(() =>
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/restart",
        commandId: "restart-1",
        serverId: "mcp-1",
        force: true,
      }),
    ).toThrow('mcp/restart carries unknown field "force"');
    expect(() =>
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/kill",
        commandId: "kill-1",
      }),
    ).toThrow('MCP lifecycle command "mcp/kill" is unknown');
    expect(() =>
      decodeMcpLifecycleCommandV1({
        schemaVersion: 1,
        type: "mcp/add-server",
        commandId: "add-1",
        label: "Example",
        url: "https://mcp.example.test/mcp",
        transport: "carrier-pigeon",
      }),
    ).toThrow("MCP transport is invalid");
  });

  test("decodes a receipt and its refusal code", () => {
    expect(
      decodeMcpLifecycleReceiptV1({
        schemaVersion: 1,
        commandId: "add-1",
        status: "refused",
        code: "unsupported-transport",
        failure: "stdio is not supported",
      }).code,
    ).toBe("unsupported-transport");
  });
});

describe("the mount outcome that crosses back from a Bot", () => {
  test("decodes a reported outcome", () => {
    expect(
      decodeMcpMountOutcomeV1({
        connectionId: "mcp-1",
        serverEpoch: 3,
        state: "error",
        failure: { code: "unreachable", message: "MCP server answered 404" },
      }),
    ).toMatchObject({ serverEpoch: 3, state: "error" });
  });

  test("refuses a Bot that tries to report a whole record", () => {
    expect(() =>
      decodeMcpMountOutcomeV1({
        connectionId: "mcp-1",
        state: "ready",
        label: "Renamed by the Bot",
      }),
    ).toThrow('MCP mount outcome carries unknown field "label"');
  });
});

describe("the Assignment resolution key", () => {
  test("changes when the server epoch changes, and only then", () => {
    const before = mcpConnectionResolutionKeyV1({
      connectionId: "mcp-1",
      connectionGeneration: "gen-1",
      serverEpoch: 1,
    });
    const restarted = mcpConnectionResolutionKeyV1({
      connectionId: "mcp-1",
      connectionGeneration: "gen-1",
      serverEpoch: 2,
    });
    const again = mcpConnectionResolutionKeyV1({
      connectionId: "mcp-1",
      connectionGeneration: "gen-1",
      serverEpoch: 1,
    });
    expect(restarted).not.toBe(before);
    expect(again).toBe(before);
  });

  test("changes when the Connection generation changes", () => {
    expect(
      mcpConnectionResolutionKeyV1({
        connectionId: "mcp-1",
        connectionGeneration: "gen-2",
        serverEpoch: 1,
      }),
    ).not.toBe(
      mcpConnectionResolutionKeyV1({
        connectionId: "mcp-1",
        connectionGeneration: "gen-1",
        serverEpoch: 1,
      }),
    );
  });
});

describe("classifying a handshake failure", () => {
  test("tells a credential a User can replace from a server that is not there", () => {
    expect(
      mcpFailureCodeV1(new McpProtocolError("MCP server answered 401", 401)),
    ).toBe("unauthorized");
    expect(
      mcpFailureCodeV1(new McpProtocolError("MCP server answered 403", 403)),
    ).toBe("unauthorized");
    expect(
      mcpFailureCodeV1(new McpProtocolError("MCP server answered 404", 404)),
    ).toBe("unreachable");
    expect(mcpFailureCodeV1(new TypeError("fetch failed"))).toBe("unreachable");
  });

  test("names a quota breach as a quota breach", () => {
    expect(
      mcpFailureCodeV1(
        new McpProtocolError("MCP server offers more than 64 tools"),
      ),
    ).toBe("tool-quota");
    expect(
      mcpFailureCodeV1(new McpProtocolError("MCP response is too large")),
    ).toBe("response-quota");
    expect(
      mcpFailureCodeV1(new McpProtocolError("MCP reply does not answer")),
    ).toBe("protocol");
  });
});
