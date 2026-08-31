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
 * into the process environment. Only the opt-in live Sprite probe uses it.
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
 * `<tool name>:<JSON arguments>`.
 *
 * The stub is shared by every test in the run and cannot be reconfigured per
 * test, so the trigger travels on the wire with the request it belongs to.
 */
export const TOOL_CALL_TRIGGER = "frockbot-test-tool-call:";

interface WireMessage {
  role?: unknown;
  content?: unknown;
}

/** The scripted tool call one request asks for, when it asks for one. */
function scriptedToolCall(
  body: unknown,
): { name: string; arguments: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  // A tool result must fall through to prose, or the loop would call the same
  // tool forever and exhaust its step budget.
  const last = messages.at(-1) as WireMessage | undefined;
  if (last?.role === "tool") return undefined;
  const user = [...(messages as WireMessage[])]
    .reverse()
    .find((message) => message.role === "user");
  const content = typeof user?.content === "string" ? user.content : "";
  if (!content.startsWith(TOOL_CALL_TRIGGER)) return undefined;
  const request = content.slice(TOOL_CALL_TRIGGER.length);
  const separator = request.indexOf(":");
  if (separator < 1) return undefined;
  return {
    name: request.slice(0, separator),
    arguments: request.slice(separator + 1),
  };
}

function toolCallStream(call: { name: string; arguments: string }): Response {
  const event = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
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

export async function ollamaCloudStub(request: Request): Promise<Response> {
  const url = new URL(request.url);
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
    const call = scriptedToolCall(body);
    if (call) return toolCallStream(call);
    return new Response(
      'data: {"choices":[{"delta":{"content":"Ollama reply"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response("unexpected Ollama Cloud request", { status: 404 });
}

/** The only host the `@fly/sprites` 0.1.0 SDK contacts. */
const SPRITES_HOST = "api.sprites.dev";

/**
 * The `outboundService` both configs install.
 *
 * Every request is answered by {@link ollamaCloudStub}, with one exception:
 * the opt-in live Sprite probe has to reach the real Sprites API. Without the
 * pass-through the stub 403s `api.sprites.dev` and the probe records a network
 * refusal instead of the workerd chunk-framing failure it exists to observe.
 * Nothing else is ever let out, and the pass-through is off unless
 * `FROCKBOT_RUN_LIVE_SPRITE_TEST=1`.
 */
export function createOutboundService(options: {
  liveSpriteProbe: boolean;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (options.liveSpriteProbe && new URL(request.url).host === SPRITES_HOST) {
      // This callback runs in Node, where `fetch(request)` cannot consume a
      // Miniflare `Request` ("Failed to parse URL from [object Request]"), so
      // the request is replayed field by field.
      return (await fetch(request.url, {
        method: request.method,
        headers: request.headers as unknown as HeadersInit,
        body: request.body as unknown as BodyInit | null,
        ...(request.body ? { duplex: "half" } : {}),
      } as RequestInit)) as unknown as Response;
    }
    return ollamaCloudStub(request);
  };
}
