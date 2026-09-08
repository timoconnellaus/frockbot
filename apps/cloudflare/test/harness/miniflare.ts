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
import { dynamicToolInputV1 } from "../dynamic-tools.ts";

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

/** A key whose first completion is a 503 and whose next one succeeds. */
export const OLLAMA_FLAKY_API_KEY = "workerd-flaky-key";
let ollamaFlakyCompletionCalls = 0;

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
 * on 2026-08-31: the catalog reads answer 200 for any key at all, and only
 * the two chat endpoints authenticate. Reproducing that asymmetry is what
 * lets a test prove the Connection is validated by an inference call and not
 * by a catalog read.
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

/** A test-only script for one tool call on each model step. */
export const REPEATED_TOOL_CALL_TRIGGER = "frockbot-test-repeated-tool-call:";

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

/**
 * One scripted call to a first-party tool, as a model reaches it.
 *
 * Every first-party tool but the Shell's own `send_to_user` and `wake_parent`
 * is registered in the `frockbot` namespace, so it is discovered and then
 * called through `call_dynamic_tool`. A script that names one bare is an
 * unknown tool, exactly as it would be in production.
 */
export function frockbotToolCall(
  name: string,
  input: unknown = {},
): [name: string, input: unknown] {
  return [
    "call_dynamic_tool",
    dynamicToolInputV1({ namespace: "frockbot", toolName: name, input }),
  ];
}

/** The trigger message for one scripted first-party tool call. */
export function frockbotToolCallPrompt(name: string, input?: unknown): string {
  return toolCallTriggerPrompt(frockbotToolCall(name, input));
}

/**
 * Whether a durable `tool/call` event is a call to the named first-party tool.
 *
 * The journalled name is the wrapper the model called; the tool it meant is
 * inside it.
 */
export function callsFrockbotTool(event: unknown, name: string): boolean {
  const journalled = event as {
    type?: unknown;
    call?: { name?: unknown; input?: { toolName?: unknown } };
  };
  return (
    journalled.type === "tool/call" &&
    journalled.call?.name === "call_dynamic_tool" &&
    journalled.call.input?.toolName === name
  );
}

/**
 * Makes the outbound fake call one tool `count` times, then answer in prose.
 * The call id is derived from the current Turn transcript, so eviction and
 * replay produce the same occurrence ids without mutable fake-side state.
 */
export function repeatedToolCallPrompt(
  count: number,
  name: string,
  input: unknown = {},
): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > 63) {
    throw new Error("repeated tool-call count must be from 1 to 63");
  }
  return `${REPEATED_TOOL_CALL_TRIGGER}${JSON.stringify({ count, name, input })}`;
}

interface WireMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

/**
 * The sentinel a conversation puts in its own Turns to make the compaction
 * summariser hang. It has to travel in the *conversation*, because the
 * summariser's request is composed by the product and carries the covered
 * Turns verbatim — which is exactly how the stub recognises one.
 */
export const STALLED_SUMMARISER_SENTINEL = "STALL-SUMMARISER";

/** How long this request should hang for, or 0 when it should not. */
function summariserStallMs(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  const system = (messages as WireMessage[]).find(
    (message) => message.role === "system",
  );
  const instruction = typeof system?.content === "string" ? system.content : "";
  if (!instruction.startsWith("You are compressing the earlier part")) return 0;
  return JSON.stringify(messages).includes(STALLED_SUMMARISER_SENTINEL)
    ? 5_000
    : 0;
}

function structuredCompactionStream(body: unknown): Response | undefined {
  if (!body || typeof body !== "object") return undefined;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  const system = (messages as WireMessage[]).find(
    (message) => message.role === "system",
  );
  const instruction = typeof system?.content === "string" ? system.content : "";
  if (!instruction.includes("Return only JSON matching this schema exactly:")) {
    return undefined;
  }
  const content = JSON.stringify({
    summary: "Ollama summary",
    decisions: [],
    openItems: [],
    identifiers: [],
  });
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** The scripted tool calls one request asks for, empty when it asks for none. */
function scriptedToolCalls(
  body: unknown,
): Array<{ id?: string; name: string; arguments: string }> {
  if (!body || typeof body !== "object") return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const userIndex = (messages as WireMessage[]).findLastIndex(
    (message) => message.role === "user",
  );
  const user = (messages as WireMessage[])[userIndex];
  const content = typeof user?.content === "string" ? user.content : "";
  const current = (messages as WireMessage[]).slice(userIndex + 1);
  for (const line of content.split("\n")) {
    if (!line.startsWith(REPEATED_TOOL_CALL_TRIGGER)) continue;
    try {
      const script = JSON.parse(
        line.slice(REPEATED_TOOL_CALL_TRIGGER.length),
      ) as { count?: unknown; name?: unknown; input?: unknown };
      const completed = current.filter(
        (message) => message.role === "tool",
      ).length;
      if (
        Number.isSafeInteger(script.count) &&
        (script.count as number) > completed &&
        typeof script.name === "string" &&
        script.name.length > 0
      ) {
        return [
          {
            id: `repeat-call-${completed + 1}`,
            name: script.name,
            arguments: JSON.stringify(script.input ?? {}),
          },
        ];
      }
      return [];
    } catch {
      return [];
    }
  }
  // An ordinary scripted tool result falls through to prose. Repeating is an
  // explicit separate trigger so an existing test can never loop by accident.
  const last = messages.at(-1) as WireMessage | undefined;
  if (last?.role === "tool") return [];
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
  calls: ReadonlyArray<{ id?: string; name: string; arguments: string }>,
): Response {
  const event = {
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id ?? `call-${index + 1}`,
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

/**
 * The stub origin the web-tools suite fetches. It is a real origin name with a
 * dot, so `web_fetch`'s classifier allows it, and it is answered here rather
 * than on the network: nothing in this repository's tests ever leaves the
 * machine except the opt-in live Computer probe.
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
 * chat endpoints and unlike the catalog reads.
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
    if (
      key !== OLLAMA_GOOD_API_KEY &&
      key !== OLLAMA_REVOKED_API_KEY &&
      key !== OLLAMA_FLAKY_API_KEY
    ) {
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
    if (key === OLLAMA_FLAKY_API_KEY) {
      ollamaFlakyCompletionCalls += 1;
      if (ollamaFlakyCompletionCalls === 1) {
        return Response.json(
          { error: { message: "temporarily unavailable", code: "overloaded" } },
          { status: 503 },
        );
      }
    } else if (key !== OLLAMA_GOOD_API_KEY) {
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
    const stall = summariserStallMs(body);
    if (stall > 0) await sleep(stall, request.signal);
    const compaction = structuredCompactionStream(body);
    if (compaction) return compaction;
    const calls = scriptedToolCalls(body);
    if (calls.length > 0) return toolCallStream(calls);
    const wire = body as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: WireMessage[];
    };
    const canSend = wire?.tools?.some(
      (tool) => tool.function?.name === "send_to_user",
    );
    const messages = wire?.messages ?? [];
    const sinceUser = messages.slice(
      messages.findLastIndex((message) => message.role === "user") + 1,
    );
    const sent = sinceUser.some((message) =>
      message.tool_calls?.some(
        (call) => call.function?.name === "send_to_user",
      ),
    );
    if (canSend && !sent)
      return toolCallStream([
        {
          id: "reply-send",
          name: "send_to_user",
          arguments: JSON.stringify({
            disposition: "finish",
            payload: { type: "text", text: "Ollama reply" },
          }),
        },
      ]);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: canSend ? "" : "Ollama reply" } }] })}\n\n` +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"prompt_eval_count":20,"eval_count":6}\n\n' +
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
 * is ever let out. There is no longer an exception for the Computer host's
 * own vendor API: the host app holds the SDK and the token, so no Worker under
 * test has any business reaching it at all.
 */
export function createOutboundService(): (
  request: Request,
) => Promise<Response> {
  return (request: Request): Promise<Response> =>
    Promise.resolve(ollamaCloudStub(request));
}
