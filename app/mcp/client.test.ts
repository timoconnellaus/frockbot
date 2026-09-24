import { describe, expect, test } from "bun:test";
import {
  classifyMcpServerUrlV1,
  guardedMcpFetchV1,
  McpRefusedError,
  mcpResultTextV1,
  McpUnauthorizedError,
  McpUnreachableError,
  withMcpSessionV1,
} from "./client.js";
import { createFakeMcpServerV1 } from "./testing.js";

const echo = {
  name: "echo",
  description: "Say it back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  run: (args: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: `echo: ${String(args.message)}` }],
  }),
};

describe("MCP server addresses", () => {
  test("take a public https address, its own port included", () => {
    expect(classifyMcpServerUrlV1("https://mcp.example.com/mcp#x")).toEqual({
      url: "https://mcp.example.com/mcp",
      host: "mcp.example.com",
    });
    expect(classifyMcpServerUrlV1("https://mcp.example.com:8443/")).toEqual({
      url: "https://mcp.example.com:8443/",
      host: "mcp.example.com:8443",
    });
  });

  test("refuse anything that is not one", () => {
    for (const candidate of [
      "",
      "mcp.example.com",
      "http://mcp.example.com/mcp",
      "https://user:pass@mcp.example.com/",
      "https://localhost/mcp",
      "https://10.0.0.4/mcp",
      "https://metadata/mcp",
    ]) {
      expect(classifyMcpServerUrlV1(candidate)).toHaveProperty("refusal");
    }
  });
});

describe("the MCP session", () => {
  test("hands shakes, lists and calls over streamable HTTP", async () => {
    const server = createFakeMcpServerV1({
      tools: [echo],
      instructions: "Use echo to repeat things.",
    });
    const result = await withMcpSessionV1(
      { url: server.url, fetch: server.fetch },
      async (session) => ({
        info: session.info,
        tools: await session.listTools(),
        answer: mcpResultTextV1(
          await session.callTool("echo", { message: "hello" }),
        ),
      }),
    );
    expect(result.info).toEqual({
      transport: "streamable-http",
      serverName: "fake-mcp",
      serverVersion: "1.2.3",
      instructions: "Use echo to repeat things.",
    });
    expect(result.tools).toEqual([
      {
        name: "echo",
        description: "Say it back.",
        inputSchema: echo.inputSchema,
      },
    ]);
    expect(result.answer).toBe("echo: hello");
    expect(server.calls).toEqual([
      { name: "echo", args: { message: "hello" } },
    ]);
  });

  test("presents the token it was handed on every request", async () => {
    const server = createFakeMcpServerV1({ tools: [echo], token: "secret" });
    await withMcpSessionV1(
      { url: server.url, fetch: server.fetch, token: "secret" },
      (session) => session.listTools(),
    );
    expect(server.authorizations.length).toBeGreaterThan(0);
    expect(new Set(server.authorizations)).toEqual(new Set(["Bearer secret"]));
  });

  test("says a server wants a credential it does not hold", async () => {
    const server = createFakeMcpServerV1({ tools: [echo], token: "secret" });
    await expect(
      withMcpSessionV1({ url: server.url, fetch: server.fetch }, (session) =>
        session.listTools(),
      ),
    ).rejects.toBeInstanceOf(McpUnauthorizedError);
    await expect(
      withMcpSessionV1(
        { url: server.url, fetch: server.fetch, token: "wrong" },
        (session) => session.listTools(),
      ),
    ).rejects.toBeInstanceOf(McpUnauthorizedError);
  });

  test("tries the older SSE transport when the address refuses a POST", async () => {
    const methods: string[] = [];
    const fetcher = async (_input: string | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response("no", { status: 405 });
    };
    await expect(
      withMcpSessionV1(
        { url: "https://mcp.example.test/sse", fetch: fetcher },
        (session) => session.listTools(),
      ),
    ).rejects.toBeInstanceOf(McpUnreachableError);
    expect(methods[0]).toBe("POST");
    expect(methods).toContain("GET");
  });

  test("a protocol refusal is the server's answer, not an unknown outcome", async () => {
    const server = createFakeMcpServerV1({ tools: [echo] });
    const inner = server.fetch;
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes('"tools/call"')) {
        const id = (JSON.parse(body) as { id: number }).id;
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Unknown tool: nope" },
        });
      }
      return inner(input, init);
    };
    await expect(
      withMcpSessionV1({ url: server.url, fetch: fetcher }, (session) =>
        session.callTool("nope", {}),
      ),
    ).rejects.toBeInstanceOf(McpRefusedError);
  });
});

describe("the guarded fetch", () => {
  test("classifies every hop and follows only method-keeping redirects", async () => {
    const seen: string[] = [];
    const guarded = guardedMcpFetchV1(async (input) => {
      seen.push(String(input));
      if (String(input).endsWith("/old")) {
        return new Response(null, {
          status: 308,
          headers: { location: "/mcp" },
        });
      }
      if (String(input).endsWith("/private")) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://127.0.0.1/mcp" },
        });
      }
      if (String(input).endsWith("/moved")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/mcp" },
        });
      }
      return new Response("ok");
    });
    expect(
      await (await guarded("https://mcp.example.test/old", {})).text(),
    ).toBe("ok");
    expect(seen).toEqual([
      "https://mcp.example.test/old",
      "https://mcp.example.test/mcp",
    ]);
    await expect(
      guarded("https://mcp.example.test/private", {}),
    ).rejects.toBeInstanceOf(McpUnreachableError);
    await expect(
      guarded("https://mcp.example.test/moved", {}),
    ).rejects.toBeInstanceOf(McpUnreachableError);
    await expect(guarded("https://192.168.1.1/mcp", {})).rejects.toBeInstanceOf(
      McpUnreachableError,
    );
  });

  test("stops reading a body past its bound", async () => {
    const guarded = guardedMcpFetchV1(
      async () => new Response(new Uint8Array(9 * 1024 * 1024)),
    );
    const response = await guarded("https://mcp.example.test/mcp", {});
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(
      McpUnreachableError,
    );
  });
});

describe("a tool's answer", () => {
  test("keeps text and names what it cannot show", () => {
    expect(
      mcpResultTextV1({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          {
            type: "resource_link",
            uri: "https://example.test/a",
            name: "a",
          },
        ],
      }),
    ).toBe("one\n[image: image/png]\n[resource: https://example.test/a (a)]");
    expect(
      mcpResultTextV1({ content: [], structuredContent: { ok: true } }),
    ).toBe('{"ok":true}');
  });
});
