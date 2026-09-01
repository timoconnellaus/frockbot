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
  // Trigger lines are found wherever they sit in the message, because a Turn
  // the product itself composes — a Routine cue, or a chat Turn carrying a
  // drained hand-off — wraps the text a test wrote in framing of its own.
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith(TOOL_CALL_TRIGGER)) continue;
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
  if (
    url.pathname.startsWith(
      "/.well-known/oauth-protected-resource/mcp-oauth/",
    ) ||
    url.pathname.startsWith("/mcp-oauth/")
  ) {
    return mcpOAuthProtectedStub(request, url);
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
  return mcpJsonRpc(request);
}

/**
 * The four JSON-RPC messages the stub answers, with no opinion about how the
 * caller authenticated. Shared by the keyed endpoint and the OAuth-protected
 * one, so both prove the same protocol.
 */
async function mcpJsonRpc(request: Request): Promise<Response> {
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

/**
 * The Telegram Bot API, stubbed at the same outbound seam as everything else.
 *
 * It is the real origin name, because the connector holds it as a constant —
 * a Bot API root that a Connection could override would be one more place a
 * bot token could be sent somewhere it was never meant to go. Nothing leaves
 * the machine: this handler runs in Node and answers every call.
 */
export const TELEGRAM_ORIGIN = "https://api.telegram.org";

/** The bot token the stub accepts. */
export const TELEGRAM_GOOD_BOT_TOKEN = "111111:workerd-telegram-token";
/** A token the stub accepts and then rate-limits on every `sendMessage`. */
export const TELEGRAM_LIMITED_BOT_TOKEN = "429429:workerd-telegram-limited";
/** A token Telegram itself rejects, so `getMe` fails and the Connection does. */
export const TELEGRAM_BAD_BOT_TOKEN = "000000:workerd-telegram-not-a-token";

/** Where a test reads what the stub was asked to do, and resets it. */
export const TELEGRAM_LEDGER_ENDPOINT = `${TELEGRAM_ORIGIN}/control/ledger`;

interface TelegramCall {
  method: string;
  /** Whether the caller presented the good token. Never the token itself. */
  token: "good" | "limited" | "bad" | "unknown";
  body: unknown;
}

const telegramCalls: TelegramCall[] = [];
let telegramMessageId = 1_000;

function telegramTokenKind(token: string): TelegramCall["token"] {
  if (token === TELEGRAM_GOOD_BOT_TOKEN) return "good";
  if (token === TELEGRAM_LIMITED_BOT_TOKEN) return "limited";
  if (token === TELEGRAM_BAD_BOT_TOKEN) return "bad";
  return "unknown";
}

async function telegramStub(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/control/ledger") {
    if (request.method === "DELETE") {
      telegramCalls.length = 0;
      return Response.json({ cleared: true });
    }
    return Response.json({ calls: telegramCalls });
  }
  const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
  if (!match) {
    return Response.json(
      { ok: false, description: "Not Found" },
      { status: 404 },
    );
  }
  const token = decodeURIComponent(match[1]!);
  const method = match[2]!;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = undefined;
  }
  const kind = telegramTokenKind(token);
  telegramCalls.push({ method, token: kind, body });
  if (kind === "unknown" || kind === "bad") {
    return Response.json(
      { ok: false, error_code: 401, description: "Unauthorized" },
      { status: 401 },
    );
  }
  if (method === "getMe") {
    return Response.json({
      ok: true,
      result: {
        id: 111111,
        is_bot: true,
        first_name: "Stub",
        username: "stub_bot",
      },
    });
  }
  if (method === "setWebhook" || method === "deleteWebhook") {
    return Response.json({ ok: true, result: true });
  }
  if (method === "sendMessage") {
    if (kind === "limited") {
      // The ordinary way Telegram says "not now". The Channel has to record it.
      return Response.json(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
          parameters: { retry_after: 30 },
        },
        { status: 429 },
      );
    }
    telegramMessageId += 1;
    return Response.json({
      ok: true,
      result: { message_id: telegramMessageId },
    });
  }
  return Response.json(
    { ok: false, description: `unexpected Telegram method ${method}` },
    { status: 400 },
  );
}

export async function ollamaCloudStub(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === TELEGRAM_ORIGIN) return telegramStub(request, url);
  if (url.origin === MCP_ORIGIN) return mcpServerStub(request);
  if (url.origin === MCP_OAUTH_ORIGIN) {
    return mcpAuthorizationServerStub(request);
  }
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

/**
 * The OAuth half of the MCP stub: one authorization server, and one MCP
 * endpoint behind it.
 *
 * It lives at the outbound seam beside the plain MCP server for the same
 * reason that one does — `plugin-mcp` reaches every authorization server with
 * the Package's own `fetch`, so impersonating one here proves the production
 * request shapes without injecting anything past a Package boundary. Between
 * them the two stubs cover the whole `mcp-oauth` flow: RFC 9728 metadata on
 * the resource, RFC 8414 metadata on the server, RFC 7591 registration, the
 * authorization redirect, both token grants, and RFC 7009 revocation.
 */
export const MCP_OAUTH_ORIGIN = "https://mcp-oauth.example.test";
/**
 * The OAuth-protected MCP endpoint for one *tenant*.
 *
 * Tenants exist because the stub is one shared module for a whole parallel
 * test run: a test that makes its connector refuse every bearer must not make
 * another file's connector refuse one too. Each test names its own tenant, and
 * every counter and every switch below is scoped to it.
 */
export function mcpOAuthEndpoint(tenant: string): string {
  return `${MCP_ORIGIN}/mcp-oauth/${tenant}`;
}

export function mcpOAuthResourceMetadataUrl(tenant: string): string {
  return `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp-oauth/${tenant}`;
}

/**
 * Makes one tenant's MCP endpoint refuse every bearer, however fresh — the
 * shape of a grant a User withdrew at the resource rather than at the
 * authorization server. A refresh still succeeds; the resource still says no,
 * which is the only way to reach the mount-time 401 `needs-auth` is for.
 */
export function mcpOAuthRejectEndpoint(tenant: string): string {
  return `${MCP_OAUTH_ORIGIN}/control/reject?tenant=${encodeURIComponent(tenant)}`;
}

/** Undoes it. */
export function mcpOAuthAcceptEndpoint(tenant: string): string {
  return `${MCP_OAUTH_ORIGIN}/control/accept?tenant=${encodeURIComponent(tenant)}`;
}

/** Expires every access token issued for one tenant. */
export function mcpOAuthExpireEndpoint(tenant: string): string {
  return `${MCP_OAUTH_ORIGIN}/control/expire?tenant=${encodeURIComponent(tenant)}`;
}

/** What the stub has issued and been asked for one tenant, so a test can prove the wire. */
export function mcpOAuthLedgerEndpoint(tenant: string): string {
  return `${MCP_OAUTH_ORIGIN}/control/ledger?tenant=${encodeURIComponent(tenant)}`;
}

/**
 * The access-token lifetime the stub advertises, in seconds.
 *
 * Deliberately inside `plugin-mcp`'s 60-second refresh skew, so every lease a
 * Bot's mount opens is one the driver must refresh before handing over. That
 * makes "the Turn after the server expired the token still ran" a property the
 * integration suite can assert deterministically, with no sleeping.
 */
const ACCESS_TOKEN_TTL_SECONDS = 60;

/** What this client calls itself is irrelevant here; the stub registers anyone. */
interface AuthorizationCode {
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  clientId: string;
}

interface RefreshRecord {
  clientId: string;
  resource: string;
}

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, { expired: boolean; tenant: string }>();
const refreshTokens = new Map<string, RefreshRecord>();

/**
 * Every fact a test needs to assert about the wire, counted per tenant where
 * it actually happened. Assertions run in workerd and this handler runs in
 * Node, so a counter read back over HTTP is the only way to observe what left.
 */
interface TenantLedger {
  registrations: number;
  authorizations: number;
  codeExchanges: number;
  refreshes: number;
  revocations: number;
  authorizeResource: string;
  tokenResource: string;
  refreshResource: string;
  codeChallengeMethod: string;
  pkceRejections: number;
  unauthorizedMcpCalls: number;
  rejecting: boolean;
}

const tenants = new Map<string, TenantLedger>();

function tenantOf(resource: string): string {
  const match = resource.match(/\/mcp-oauth\/([^/?#]+)/);
  return match?.[1] ?? "default";
}

function ledgerFor(tenant: string): TenantLedger {
  let value = tenants.get(tenant);
  if (!value) {
    value = {
      registrations: 0,
      authorizations: 0,
      codeExchanges: 0,
      refreshes: 0,
      revocations: 0,
      authorizeResource: "",
      tokenResource: "",
      refreshResource: "",
      codeChallengeMethod: "",
      pkceRejections: 0,
      unauthorizedMcpCalls: 0,
      rejecting: false,
    };
    tenants.set(tenant, value);
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function codeChallengeOf(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function issued(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function oauthError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

/** Whether a bearer is one this stub issued for this tenant and still honours. */
function mcpOAuthTokenIsLive(token: string, tenant: string): boolean {
  if (ledgerFor(tenant).rejecting) return false;
  const record = accessTokens.get(token);
  return record !== undefined && !record.expired && record.tenant === tenant;
}

async function tokenGrant(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grant = form.get("grant_type");
  const resource = form.get("resource") ?? "";
  const tenant = tenantOf(resource);
  const ledger = ledgerFor(tenant);
  if (grant === "authorization_code") {
    ledger.codeExchanges += 1;
    ledger.tokenResource = resource;
    const code = form.get("code") ?? "";
    const issuedCode = authorizationCodes.get(code);
    // An authorization code is single use, exactly as RFC 6749 §4.1.2 says.
    authorizationCodes.delete(code);
    if (!issuedCode) return oauthError("invalid_grant");
    const verifier = form.get("code_verifier") ?? "";
    if ((await codeChallengeOf(verifier)) !== issuedCode.codeChallenge) {
      ledger.pkceRejections += 1;
      return oauthError("invalid_grant");
    }
    if (form.get("redirect_uri") !== issuedCode.redirectUri) {
      return oauthError("invalid_grant");
    }
    // RFC 8707: a token request naming no resource would produce a token good
    // for every resource this server protects, which is the thing the
    // indicator exists to prevent.
    if (resource !== issuedCode.resource) return oauthError("invalid_target");
    const accessToken = issued("mcp-access");
    const refreshToken = issued("mcp-refresh");
    accessTokens.set(accessToken, { expired: false, tenant });
    refreshTokens.set(refreshToken, {
      clientId: issuedCode.clientId,
      resource,
    });
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: "mcp:tools",
    });
  }
  if (grant === "refresh_token") {
    ledger.refreshes += 1;
    ledger.refreshResource = resource;
    const presented = form.get("refresh_token") ?? "";
    const record = refreshTokens.get(presented);
    if (!record) return oauthError("invalid_grant");
    if (resource !== record.resource) return oauthError("invalid_target");
    const accessToken = issued("mcp-access");
    accessTokens.set(accessToken, { expired: false, tenant });
    // A server that does not rotate its refresh token: the client must carry
    // the old one forward rather than losing the ability to refresh again.
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: "mcp:tools",
    });
  }
  return oauthError("unsupported_grant_type");
}

export async function mcpAuthorizationServerStub(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const tenant = url.searchParams.get("tenant") ?? "default";
  switch (url.pathname) {
    case "/control/ledger":
      return Response.json(ledgerFor(tenant));
    case "/control/expire": {
      for (const record of accessTokens.values()) {
        if (record.tenant === tenant) record.expired = true;
      }
      return Response.json({ expired: true });
    }
    case "/control/reject": {
      ledgerFor(tenant).rejecting = true;
      return Response.json({ rejecting: true });
    }
    case "/control/accept": {
      ledgerFor(tenant).rejecting = false;
      return Response.json({ rejecting: false });
    }
    case "/.well-known/oauth-authorization-server":
      return Response.json({
        issuer: MCP_OAUTH_ORIGIN,
        authorization_endpoint: `${MCP_OAUTH_ORIGIN}/authorize`,
        token_endpoint: `${MCP_OAUTH_ORIGIN}/token`,
        registration_endpoint: `${MCP_OAUTH_ORIGIN}/register`,
        revocation_endpoint: `${MCP_OAUTH_ORIGIN}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:tools"],
      });
    case "/register": {
      const body = (await request.json().catch(() => ({}))) as {
        token_endpoint_auth_method?: unknown;
      };
      if (body.token_endpoint_auth_method !== "none") {
        return oauthError("invalid_client_metadata");
      }
      // A public client: no `client_secret`, which is what makes this server
      // one FrockBot will talk to at all. Registration carries no resource, so
      // it is counted against every tenant that later uses it.
      for (const ledger of tenants.values()) ledger.registrations += 1;
      return Response.json(
        { client_id: issued("mcp-client") },
        { status: 201 },
      );
    }
    case "/authorize": {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      const resource = url.searchParams.get("resource") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      const ledger = ledgerFor(tenantOf(resource));
      ledger.authorizations += 1;
      ledger.registrations = Math.max(ledger.registrations, 1);
      ledger.codeChallengeMethod =
        url.searchParams.get("code_challenge_method") ?? "";
      ledger.authorizeResource = resource;
      if (!redirectUri || !state || !codeChallenge || !clientId) {
        return oauthError("invalid_request");
      }
      const code = issued("mcp-code");
      authorizationCodes.set(code, {
        codeChallenge,
        redirectUri,
        resource,
        clientId,
      });
      const destination = new URL(redirectUri);
      destination.searchParams.set("code", code);
      destination.searchParams.set("state", state);
      return new Response(null, {
        status: 303,
        headers: { location: destination.toString() },
      });
    }
    case "/token":
      return tokenGrant(request);
    case "/revoke": {
      const form = new URLSearchParams(await request.text());
      const token = form.get("token") ?? "";
      const record = refreshTokens.get(token);
      ledgerFor(record ? tenantOf(record.resource) : tenant).revocations += 1;
      refreshTokens.delete(token);
      accessTokens.delete(token);
      // RFC 7009 §2.2: an unknown token is a success, so the client cannot
      // probe the server for which of its tokens are still live.
      return new Response(null, { status: 200 });
    }
    default:
      return new Response("unexpected authorization request", { status: 404 });
  }
}

/**
 * The OAuth-protected MCP endpoints, and the documents that lead to them. Each
 * answers 401 with the `WWW-Authenticate` challenge RFC 9728 §5.1 defines until
 * a live access token for *that tenant* is presented, which is exactly what
 * makes a mount's failure classifiable as `needs-auth` rather than `error`.
 */
export async function mcpOAuthProtectedStub(
  request: Request,
  url: URL,
): Promise<Response> {
  const metadata = url.pathname.match(
    /^\/\.well-known\/oauth-protected-resource\/mcp-oauth\/([^/]+)$/,
  );
  if (metadata) {
    const tenant = metadata[1]!;
    return Response.json({
      resource: mcpOAuthEndpoint(tenant),
      authorization_servers: [MCP_OAUTH_ORIGIN],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    });
  }
  const endpoint = url.pathname.match(/^\/mcp-oauth\/([^/]+)$/);
  if (!endpoint) return new Response("unexpected MCP request", { status: 404 });
  const tenant = endpoint[1]!;
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7)
    : "";
  if (!mcpOAuthTokenIsLive(token, tenant)) {
    ledgerFor(tenant).unauthorizedMcpCalls += 1;
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="mcp", resource_metadata="${mcpOAuthResourceMetadataUrl(tenant)}"`,
      },
    });
  }
  return mcpJsonRpc(request);
}
