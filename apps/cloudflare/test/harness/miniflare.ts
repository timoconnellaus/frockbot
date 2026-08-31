// Harness pieces shared by the two workerd Vitest projects:
// `vitest.config.ts` (the hermetic Durable Object compatibility suite, whose
// `SELF` is the probe Worker) and `vitest.integration.config.ts` (the
// `SELF.fetch` integration suite, whose `SELF` is `src/index.ts`, the real
// gateway). Both need the same credential keyring, the same `.dev.vars`
// reader, and the same outbound Ollama Cloud stub, so the definitions live
// here and neither config owns a copy.
//
// This module is imported by Vitest config files, so it runs in Node, not in
// workerd. It must stay free of Worker-only globals.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads one variable out of `apps/cloudflare/.dev.vars` without importing it
 * into the process environment. Nothing in the suite needs one today; it is
 * kept because a live opt-in probe is one edit away and reading `.dev.vars`
 * correctly (quoted values included) is the part that is easy to get wrong.
 */
export function readDevVariable(name: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(
      resolve(import.meta.dirname, "..", "..", ".dev.vars"),
      "utf8",
    );
  } catch {
    return undefined;
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * The User Durable Object mounts the Credential Store Contribution the moment
 * any User Contribution resolves, and `createBot` goes through it. A workerd
 * Worker is a production bootstrap, so it needs a keyring exactly as the
 * deployed Worker does; this one is a test fixture and holds nothing real.
 */
export const TEST_CREDENTIAL_KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: { primary: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY" },
});

/**
 * The key every workerd fixture connects with. `POST /api/chat` (Connection
 * validation) and `POST /v1/chat/completions` (a Turn) both accept it.
 */
export const OLLAMA_GOOD_API_KEY = "workerd-test-key";

/**
 * A key that validates and then stops working — the shape of a real key
 * revoked after its Connection reached `ready`. `POST /api/chat` accepts it,
 * so `connection/create-api-key` succeeds; `POST /v1/chat/completions` rejects
 * it, so the next Turn fails at the provider with a reason the Bot must carry
 * all the way to the client DTO.
 */
export const OLLAMA_REVOKED_API_KEY = "workerd-revoked-key";

/** Anything else is rejected by both authenticated endpoints. */
export const OLLAMA_BAD_API_KEY = "workerd-not-a-key";

const UNAUTHORIZED = JSON.stringify({ error: "Unauthorized" });

function bearerKey(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}

/**
 * The Bot and User Durable Objects reach Ollama Cloud through the global
 * `fetch` their Packages own, so the workerd harness stubs the provider at the
 * outbound seam rather than injecting a fetcher past the Package boundary. The
 * production request shapes are asserted by the Package's own tests; here the
 * stub only has to answer them.
 *
 * The authentication behaviour is the one measured against https://ollama.com
 * on 2026-08-31 and recorded in `docs/research/ollama-cloud-auth.md`: the
 * catalog reads answer 200 for any key at all, and only the two chat endpoints
 * authenticate. Reproducing that asymmetry is what lets a test prove the
 * Connection is validated by an inference call and not by a catalog read.
 */
/**
 * The marker a test puts in a user message to make the stubbed model answer
 * with a tool call instead of prose. The rest of the message is
 * `<tool name>:<JSON arguments>`, and a message may carry one such line per
 * call it wants in the response — which is how a Turn that calls two tools in
 * one step is reproduced.
 *
 * The stub is shared by every test in the run and cannot be reconfigured per
 * test, so the trigger travels on the wire with the request it belongs to.
 */
export const TOOL_CALL_TRIGGER = "frockbot-test-tool-call:";

/** Builds the trigger message for one or more scripted calls. */
export function toolCallTriggerPrompt(
  ...calls: Array<[name: string, input?: unknown]>
): string {
  return calls
    .map(
      ([name, input]) =>
        `${TOOL_CALL_TRIGGER}${name}:${JSON.stringify(input ?? {})}`,
    )
    .join("\n");
}

interface WireMessage {
  role?: unknown;
  content?: unknown;
}

/** The scripted tool calls one request asks for, empty when it asks for none. */
function scriptedToolCalls(
  body: unknown,
): Array<{ name: string; arguments: string }> {
  if (!body || typeof body !== "object") return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  // A tool result must fall through to prose, or the loop would call the same
  // tool forever and exhaust its step budget.
  const last = messages.at(-1) as WireMessage | undefined;
  if (last?.role === "tool") return [];
  const user = [...(messages as WireMessage[])]
    .reverse()
    .find((message) => message.role === "user");
  const content = typeof user?.content === "string" ? user.content : "";
  if (!content.startsWith(TOOL_CALL_TRIGGER)) return [];
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith(TOOL_CALL_TRIGGER)) return [];
    const request = line.slice(TOOL_CALL_TRIGGER.length);
    const separator = request.indexOf(":");
    if (separator < 1) return [];
    calls.push({
      name: request.slice(0, separator),
      arguments: request.slice(separator + 1),
    });
  }
  return calls;
}

function toolCallStream(
  calls: ReadonlyArray<{ name: string; arguments: string }>,
): Response {
  const event = {
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call-${index + 1}`,
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  return new Response(
    `data: ${JSON.stringify(event)}\n\n` + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** The one host the MCP stub answers, and the key it accepts. */
export const MCP_ORIGIN = "https://mcp.example.test";
export const MCP_ENDPOINT = `${MCP_ORIGIN}/mcp`;
export const MCP_GOOD_API_KEY = "workerd-mcp-key";
/** A host that is reachable but answers nothing an MCP client can use. */
export const MCP_UNREACHABLE_ENDPOINT = `${MCP_ORIGIN}/mcp-down`;
/**
 * How many `initialize` exchanges the stub has answered. It lives beside the
 * stub, in the outbound service, because that is the only place a test can
 * count what actually left the deployment — which is what proves a restart
 * makes the next Turn handshake again rather than reusing a client.
 */
export const MCP_HANDSHAKE_COUNT_ENDPOINT = `${MCP_ORIGIN}/control/handshakes`;

let mcpHandshakes = 0;

/**
 * A remote MCP server, stubbed at the same outbound seam as Ollama Cloud.
 * `plugin-mcp` reaches it with the Package's own `fetch`, so nothing is
 * injected past a Package boundary to make this work: the endpoint is
 * impersonated at the edge of the deployment exactly as a real one would sit.
 *
 * It speaks the streamable-HTTP transport, answering each POST inline as
 * `application/json`, which is what the specification allows for a server that
 * needs no server-initiated stream.
 */
export async function mcpServerStub(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/control/handshakes") {
    return Response.json({ handshakes: mcpHandshakes });
  }
  // A host that answers, and answers nothing an MCP client can use: the
  // durable `error` state a mount must record has to come from somewhere.
  if (url.pathname === "/mcp-down") {
    return new Response("the MCP server is gone", { status: 503 });
  }
  if (url.pathname !== "/mcp") {
    return new Response("unexpected MCP request", { status: 404 });
  }
  // `/mcp` is the keyed endpoint: a request without the exact bearer token is
  // refused, so a test can prove a bad key leaves the Connection failed.
  const authorization = request.headers.get("authorization");
  if (
    authorization !== null &&
    authorization !== `Bearer ${MCP_GOOD_API_KEY}`
  ) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("invalid JSON-RPC body", { status: 400 });
  }
  if (body.id === undefined) return new Response("", { status: 202 });
  const reply = (result: unknown): Response =>
    Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (body.method === "initialize") {
    mcpHandshakes += 1;
    return reply({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "Example MCP", version: "1.0.0" },
    });
  }
  if (body.method === "tools/list") {
    return reply({
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
    });
  }
  if (body.method === "tools/call") {
    const params = (body.params ?? {}) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (params.name !== "echo") {
      return reply({
        isError: true,
        content: [
          { type: "text", text: `unknown tool: ${String(params.name)}` },
        ],
      });
    }
    return reply({
      content: [
        {
          type: "text",
          text: JSON.stringify({ echoed: params.arguments ?? {} }),
        },
      ],
    });
  }
  return reply({});
}

/**
 * The stub origin the web-tools suite fetches. It is a real origin name with a
 * dot, so `web_fetch`'s classifier allows it, and it is answered here rather
 * than on the network: nothing in this repository's tests ever leaves the
 * machine except the opt-in live Sprite probe. `MCP_ORIGIN` is a *subdomain*
 * of it and is dispatched first, so the two stubs never see each other's
 * requests.
 */
export const WEB_STUB_ORIGIN = "https://example.test";

/**
 * What the stub origin serves, by path. `/counters` reports how many outbound
 * requests the stub has seen for an address `web_fetch` must never reach —
 * the only way a workerd test can observe a request that was correctly *not*
 * made, since this handler runs in Node and the assertions run in workerd.
 */
const WEB_STUB_PAGE = `<!doctype html>
<html><head><title>Stub page</title><style>.x{color:red}</style></head>
<body><h1>Stub page</h1><p>The quick brown fox &amp; friends.</p>
<a href="https://example.test/other">another page</a>
<script>window.tracked = "never-extracted";</script></body></html>`;

/** Requests the outbound seam saw for a non-public address, by host. */
const blockedAddressCalls = new Map<string, number>();

function webStub(url: URL): Response {
  if (url.pathname === "/counters") {
    return Response.json({
      metadata: blockedAddressCalls.get("169.254.169.254") ?? 0,
    });
  }
  if (url.pathname === "/plain.txt") {
    return new Response("plain body", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (url.pathname === "/binary.pdf") {
    return new Response("%PDF-1.4", {
      headers: { "content-type": "application/pdf" },
    });
  }
  return new Response(WEB_STUB_PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * The Ollama Cloud web-search endpoint. Authenticated exactly like the two
 * chat endpoints and unlike the catalog reads — the asymmetry measured in
 * `docs/research/ollama-cloud-auth.md`.
 */
async function webSearchStub(request: Request, key: string): Promise<Response> {
  if (key !== OLLAMA_GOOD_API_KEY) {
    return new Response(UNAUTHORIZED, {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  let body: { query?: unknown; max_results?: unknown } = {};
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    body = {};
  }
  const count =
    typeof body.max_results === "number" ? Math.min(body.max_results, 3) : 3;
  return Response.json({
    results: Array.from({ length: count }, (_value, index) => ({
      title: `Result ${index} for ${String(body.query ?? "")}`,
      url: `https://example.test/result-${index}`,
      content: `A snippet about ${String(body.query ?? "")}.`,
    })),
  });
}

export async function ollamaCloudStub(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === MCP_ORIGIN) return mcpServerStub(request);
  if (url.origin === WEB_STUB_ORIGIN) return webStub(url);
  if (!url.hostname.includes("ollama.com")) {
    // Anything a Bot should never reach is counted before it is refused, so a
    // test can prove the request was not made rather than only that it failed.
    blockedAddressCalls.set(
      url.hostname,
      (blockedAddressCalls.get(url.hostname) ?? 0) + 1,
    );
  }
  if (url.origin !== "https://ollama.com") {
    return new Response("outbound request is not allowed in tests", {
      status: 403,
    });
  }
  // Unauthenticated in production, and unauthenticated here: a catalog read
  // can never distinguish a good key from a bad one.
  if (url.pathname === "/api/tags") {
    return Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] });
  }
  if (url.pathname === "/api/show") {
    return Response.json({ capabilities: ["tools"], model_info: {} });
  }
  const key = bearerKey(request);
  if (url.pathname === "/api/web_search") {
    return webSearchStub(request, key);
  }
  if (url.pathname === "/api/chat") {
    if (key !== OLLAMA_GOOD_API_KEY && key !== OLLAMA_REVOKED_API_KEY) {
      return new Response(UNAUTHORIZED, {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json({
      model: "glm-5.3-flash:cloud",
      created_at: new Date(0).toISOString(),
      message: { role: "assistant", content: "h" },
      done: true,
      done_reason: "length",
    });
  }
  if (url.pathname === "/v1/chat/completions") {
    if (key !== OLLAMA_GOOD_API_KEY) {
      return new Response(UNAUTHORIZED, {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = undefined;
    }
    const calls = scriptedToolCalls(body);
    if (calls.length > 0) return toolCallStream(calls);
    return new Response(
      'data: {"choices":[{"delta":{"content":"Ollama reply"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response("unexpected Ollama Cloud request", { status: 404 });
}

/**
 * The `outboundService` both configs install.
 *
 * Every outbound request is answered by {@link ollamaCloudStub}, and nothing
 * is ever let out. There is no longer an exception for the Sprites API: the
 * Computer host holds the SDK and the token (ADR 0004), so no Worker under
 * test has any business reaching `api.sprites.dev` at all.
 */
export function createOutboundService(): (
  request: Request,
) => Promise<Response> {
  return (request: Request): Promise<Response> =>
    Promise.resolve(ollamaCloudStub(request));
}
