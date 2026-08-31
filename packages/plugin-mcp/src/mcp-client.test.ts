import { describe, expect, test } from "bun:test";
import { McpClient, McpProtocolError, parseSseEventsV1 } from "./mcp-client.js";

const ENDPOINT = new URL("https://mcp.example.test/mcp");

interface Exchange {
  method: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function jsonRpc(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function sseBody(id: unknown, result: unknown): string {
  return `event: message\ndata: ${jsonRpc(id, result)}\n\n`;
}

const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "Example", version: "1.2.3" },
};

const TOOLS_RESULT = {
  tools: [
    {
      name: "echo",
      description: "Echo a message back.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
};

/** A streamable-HTTP server that answers each POST inline. */
function streamableServer(options: {
  contentType?: "application/json" | "text/event-stream";
  onCall?: (args: unknown) => unknown;
  exchanges: Exchange[];
}): typeof fetch {
  const contentType = options.contentType ?? "application/json";
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    options.exchanges.push({
      method: String(body.method),
      body,
      headers: new Headers(init?.headers),
    });
    if (body.id === undefined) return new Response("", { status: 202 });
    const result =
      body.method === "initialize"
        ? INITIALIZE_RESULT
        : body.method === "tools/list"
          ? TOOLS_RESULT
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    options.onCall?.(
                      (body.params as Record<string, unknown>).arguments,
                    ) ?? { ok: true },
                  ),
                },
              ],
            };
    const payload =
      contentType === "application/json"
        ? jsonRpc(body.id, result)
        : sseBody(body.id, result);
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": contentType,
        ...(body.method === "initialize"
          ? { "mcp-session-id": "session-9" }
          : {}),
      },
    });
  }) as typeof fetch;
}

describe("parseSseEventsV1", () => {
  test("reads named events, multi-line data and comments", () => {
    expect(
      parseSseEventsV1(
        ": keep-alive\nevent: endpoint\ndata: /messages?s=1\n\n" +
          'data: {"a":\ndata: 1}\n\n',
      ),
    ).toEqual([
      { event: "endpoint", data: "/messages?s=1" },
      { event: "message", data: '{"a":\n1}' },
    ]);
  });
});

describe("the streamable-HTTP transport", () => {
  test("handshakes, lists tools, and passes the server's schema through", async () => {
    const exchanges: Exchange[] = [];
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: streamableServer({ exchanges }),
      apiKey: "secret-key",
    });

    const handshake = await client.connect();
    const tools = await client.listTools();

    expect(handshake).toEqual({
      protocolVersion: "2025-06-18",
      serverName: "Example",
      serverVersion: "1.2.3",
    });
    expect(tools).toEqual([
      {
        name: "echo",
        description: "Echo a message back.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ]);
    expect(exchanges.map((exchange) => exchange.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    // The key travels as a bearer token, and the session and protocol the
    // server named are echoed on every later request.
    expect(exchanges[0]!.headers.get("authorization")).toBe(
      "Bearer secret-key",
    );
    expect(exchanges[2]!.headers.get("mcp-session-id")).toBe("session-9");
    expect(exchanges[2]!.headers.get("mcp-protocol-version")).toBe(
      "2025-06-18",
    );
  });

  test("reads a reply delivered as an SSE message event", async () => {
    const exchanges: Exchange[] = [];
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: streamableServer({
        exchanges,
        contentType: "text/event-stream",
      }),
    });

    await client.connect();
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "echo",
    ]);
  });

  test("carries the call's arguments and renders text content", async () => {
    const exchanges: Exchange[] = [];
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: streamableServer({
        exchanges,
        onCall: (args) => ({ echoed: args }),
      }),
    });
    await client.connect();

    const result = await client.callTool("echo", { message: "hi" });

    expect(result).toEqual({
      content: JSON.stringify({ echoed: { message: "hi" } }),
      isError: false,
    });
    expect(exchanges.at(-1)!.body.params).toEqual({
      name: "echo",
      arguments: { message: "hi" },
    });
  });

  test("sends a header key under its own name when one is named", async () => {
    const exchanges: Exchange[] = [];
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: streamableServer({ exchanges }),
      apiKey: "secret-key",
      headerName: "X-Api-Key",
    });

    await client.connect();

    expect(exchanges[0]!.headers.get("x-api-key")).toBe("secret-key");
    expect(exchanges[0]!.headers.get("authorization")).toBeNull();
  });
});

describe("the legacy SSE transport", () => {
  function sseServer(): typeof fetch {
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | undefined;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk));
            push("event: endpoint\ndata: /mcp/messages?session=7\n\n");
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(input)).toBe(
        "https://mcp.example.test/mcp/messages?session=7",
      );
      if (body.id !== undefined) {
        push!(
          sseBody(
            body.id,
            body.method === "initialize" ? INITIALIZE_RESULT : TOOLS_RESULT,
          ),
        );
      }
      return new Response("", { status: 202 });
    }) as typeof fetch;
  }

  test("opens the stream, learns the message endpoint and reads replies", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "sse",
      fetch: sseServer(),
    });

    expect((await client.connect()).protocolVersion).toBe("2025-06-18");
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "echo",
    ]);
    await client.close();
  });

  test("refuses a message endpoint on another origin", async () => {
    const encoder = new TextEncoder();
    const client = new McpClient({
      url: ENDPOINT,
      transport: "sse",
      fetch: (() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    "event: endpoint\ndata: https://elsewhere.test/m\n\n",
                  ),
                );
                controller.close();
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
        )) as unknown as typeof fetch,
    });

    await expect(client.connect()).rejects.toThrow(/changed origin/);
  });
});

describe("bounds and failures", () => {
  test("refuses a response past the byte ceiling", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      maxResponseBytes: 64,
      fetch: (() =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "x".repeat(200) },
          }),
        )) as unknown as typeof fetch,
    });

    await expect(client.connect()).rejects.toThrow(/too large/);
  });

  test("refuses a server offering more tools than the ceiling", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      maxTools: 2,
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.id === undefined) return new Response("", { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? INITIALIZE_RESULT
              : {
                  tools: [1, 2, 3].map((index) => ({
                    name: `tool-${index}`,
                    inputSchema: { type: "object" },
                  })),
                },
        });
      }) as typeof fetch,
    });
    await client.connect();

    await expect(client.listTools()).rejects.toThrow(/more than 2 tools/);
  });

  test("reports a JSON-RPC error as a protocol failure", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32_600, message: "unsupported protocol version" },
        });
      }) as typeof fetch,
    });

    await expect(client.connect()).rejects.toThrow(McpProtocolError);
    await expect(client.connect()).rejects.toThrow(
      /unsupported protocol version/,
    );
  });

  test("reports an HTTP rejection with the server's status", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: (() =>
        Promise.resolve(
          new Response("Unauthorized", { status: 401 }),
        )) as unknown as typeof fetch,
    });

    await expect(client.connect()).rejects.toThrow(/401: Unauthorized/);
  });

  test("carries a tool that reports its own error as isError", async () => {
    const client = new McpClient({
      url: ENDPOINT,
      transport: "streamable-http",
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.id === undefined) return new Response("", { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? INITIALIZE_RESULT
              : {
                  isError: true,
                  content: [{ type: "text", text: "no such record" }],
                },
        });
      }) as typeof fetch,
    });
    await client.connect();

    expect(await client.callTool("lookup", {})).toEqual({
      content: "no such record",
      isError: true,
    });
  });
});
