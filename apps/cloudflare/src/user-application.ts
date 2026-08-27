import { createFoundationRuntime } from "@frockbot/agent-runtime/runtime";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { UserApplicationEnv } from "./contracts.js";
import { appendedSessionEvents } from "./durable-session.js";

const BOT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const USER_ID_PATTERN = BOT_ID_PATTERN;
const APPLICATION_HASH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const MAX_INPUT_LENGTH = 32_000;

declare const __FROCKBOT_CLIENT_JS__: string;
declare const __FROCKBOT_CLIENT_CSS__: string;

const APP_JS =
  typeof __FROCKBOT_CLIENT_JS__ === "string"
    ? __FROCKBOT_CLIENT_JS__
    : "throw new Error('Worker renderer was not bundled')";
const APP_CSS =
  typeof __FROCKBOT_CLIENT_CSS__ === "string" ? __FROCKBOT_CLIENT_CSS__ : "";

function appHtml(userId: string, applicationHash: string): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("invalid user id");
  if (!APPLICATION_HASH_PATTERN.test(applicationHash)) {
    throw new Error("invalid application hash");
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="frockbot-application" content="${applicationHash}">
  <title>FrockBot</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body data-frockbot-user-id="${userId}" data-frockbot-user-application="${applicationHash}">
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return secured;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function memoryPluginConfig(
  env: UserApplicationEnv,
  agentId: string,
): MemoryPluginConfig {
  return {
    ownerId: env.DEPLOYMENT.userId,
    agentId,
    bucket: {
      get: async (key) => {
        const body = await env.MEMORY.get(key);
        return body === null
          ? null
          : {
              text: () => Promise.resolve(body),
              json: <T>() => Promise.resolve(JSON.parse(body) as T),
            };
      },
      put: (key, value, options) =>
        env.MEMORY.put(key, value, options?.httpMetadata?.contentType),
      delete: (key) => env.MEMORY.delete(key),
      list: ({ prefix, cursor }) => env.MEMORY.list(prefix, cursor),
    },
    vectorize: {
      upsert: (vectors) => env.MEMORY.vectorUpsert(vectors),
      query: (vector, options) => env.MEMORY.vectorQuery(vector, options),
      deleteByIds: (ids) => env.MEMORY.vectorDeleteByIds(ids),
    },
    ai: {
      run: (model, input) => env.MEMORY.embed(model, input.text),
    },
  };
}

async function readPrompt(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INPUT_LENGTH * 2)
    throw new Error("prompt is too large");
  const value: unknown = await request.json();
  const text =
    typeof value === "object" && value !== null && "text" in value
      ? (value as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("prompt text is required");
  }
  if (text.length > MAX_INPUT_LENGTH) throw new Error("prompt is too large");
  return text.trim();
}

export function createUserApplication() {
  return async (
    request: Request,
    env: UserApplicationEnv,
  ): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonError(400, "invalid request URL");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return withSecurityHeaders(
        new Response(
          appHtml(env.DEPLOYMENT.userId, env.DEPLOYMENT.applicationHash),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      return withSecurityHeaders(
        new Response(APP_JS, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
          },
        }),
      );
    }
    if (request.method === "GET" && url.pathname === "/app.css") {
      return withSecurityHeaders(
        new Response(APP_CSS, {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-cache",
          },
        }),
      );
    }
    if (request.method === "GET" && url.pathname === "/app-manifest") {
      return Response.json({
        schemaVersion: 1,
        deployment: env.DEPLOYMENT,
        contributions: ["frockbot.shell", "clock.agent"],
      });
    }

    const turnMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/turns$/);
    if (!turnMatch) return jsonError(404, "not found");
    let botId: string;
    try {
      botId = decodeURIComponent(turnMatch[1]);
    } catch {
      return jsonError(400, "invalid bot id");
    }
    if (!BOT_ID_PATTERN.test(botId)) return jsonError(400, "invalid bot id");

    if (request.method === "GET") {
      return Response.json({ runs: await env.BOT_STATE.listRuns(botId) });
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");

    let text: string;
    try {
      text = await readPrompt(request);
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error ? error.message : "invalid prompt",
      );
    }

    const runId = crypto.randomUUID();
    const sessionId = `${env.DEPLOYMENT.userId}:${botId}`;
    const sessionEvents = await env.BOT_STATE.acceptRun(botId, {
      runId,
      sessionId,
      acceptedAt: new Date().toISOString(),
      input: text,
    });

    const runtime = await createFoundationRuntime(undefined, {
      sessionId,
      sessionEvents,
      memory: memoryPluginConfig(env, botId),
    });

    try {
      runtime.agent.agent.send(text);
      await runtime.agent.agent.whenIdle();
      const events = [...runtime.agent.agent.session.events];
      const runEvents = appendedSessionEvents(sessionEvents, events);
      await env.BOT_STATE.completeRun(botId, runId, events);
      const message = runtime.agent.agent.session.deriveMessages().at(-1);
      return Response.json({
        runId,
        text: message?.role === "assistant" ? message.content : "",
        events: runEvents,
      });
    } finally {
      await runtime.dispose();
    }
  };
}

const fetchUserApplication = createUserApplication();

export default {
  fetch: fetchUserApplication,
} satisfies ExportedHandler<UserApplicationEnv>;
