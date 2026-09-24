// A real MCP server for tests, reached through a `fetch` rather than a
// socket: the official server SDK behind its web-standard streamable HTTP
// transport, stateless, so each request is served by a fresh instance.
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { McpFetchV1 } from "./client.js";

export interface FakeMcpToolV1 {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
}

export interface FakeMcpServerV1 {
  /** Where the server answers. */
  readonly url: string;
  readonly fetch: McpFetchV1;
  /** Every tool call the server ran, in order. */
  readonly calls: { name: string; args: Record<string, unknown> }[];
  /** Every Authorization header the server was sent. */
  readonly authorizations: (string | null)[];
  tools: FakeMcpToolV1[];
  /** The bearer token the server accepts; absent accepts anything. */
  token?: string;
  /** Answer every request with this status instead of serving it. */
  status?: number;
}

export function createFakeMcpServerV1(
  options: {
    url?: string;
    tools?: FakeMcpToolV1[];
    token?: string;
    instructions?: string;
  } = {},
): FakeMcpServerV1 {
  const url = options.url ?? "https://mcp.example.test/mcp";
  const state: FakeMcpServerV1 = {
    url,
    calls: [],
    authorizations: [],
    tools: options.tools ?? [],
    ...(options.token ? { token: options.token } : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      state.authorizations.push(request.headers.get("authorization"));
      if (state.status !== undefined) {
        return new Response("refused", { status: state.status });
      }
      if (new URL(request.url).href !== url) {
        return new Response("not found", { status: 404 });
      }
      if (
        state.token &&
        request.headers.get("authorization") !== `Bearer ${state.token}`
      ) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      const server = new Server(
        { name: "fake-mcp", version: "1.2.3" },
        {
          capabilities: { tools: {} },
          ...(options.instructions
            ? { instructions: options.instructions }
            : {}),
        },
      );
      server.setRequestHandler("tools/list", () => ({
        tools: state.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as { type: "object" },
        })),
      }));
      server.setRequestHandler("tools/call", (call) => {
        const tool = state.tools.find(
          (candidate) => candidate.name === call.params.name,
        );
        const args = (call.params.arguments ?? {}) as Record<string, unknown>;
        state.calls.push({ name: call.params.name, args });
        if (!tool) {
          return {
            content: [{ type: "text", text: "no such tool" }],
            isError: true,
          };
        }
        return tool.run(args);
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  };
  return state;
}
