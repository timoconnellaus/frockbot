import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { UserApplicationEnv } from "./contracts.js";

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
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return secured;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function readTurnCommand(
  request: Request,
): Promise<{ commandId: string; text: string }> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INPUT_LENGTH * 2)
    throw new Error("prompt is too large");
  const value: unknown = await request.json();
  const text =
    typeof value === "object" && value !== null && "text" in value
      ? (value as { text?: unknown }).text
      : undefined;
  const commandId =
    typeof value === "object" && value !== null && "commandId" in value
      ? (value as { commandId?: unknown }).commandId
      : undefined;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("prompt text is required");
  }
  if (text.length > MAX_INPUT_LENGTH) throw new Error("prompt is too large");
  if (typeof commandId !== "string" || !BOT_ID_PATTERN.test(commandId)) {
    throw new Error("commandId is invalid");
  }
  return { commandId, text: text.trim() };
}

export function createUserApplication() {
  const application = createFoundationRuntimeApplication();
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
      const compiled = await application;
      return Response.json({
        schemaVersion: 1,
        deployment: env.DEPLOYMENT,
        applicationHash: compiled.plan.applicationHash,
        packages: compiled.plan.packages.map((pkg) => ({
          id: pkg.id,
          displayName: pkg.manifest.displayName,
          version: pkg.version,
          contributions: [
            ...(pkg.manifest.contributions.backend ? ["backend"] : []),
            ...(pkg.manifest.contributions.runtime ? ["runtime"] : []),
            ...(pkg.manifest.contributions.client ? ["client"] : []),
            ...(pkg.manifest.contributions.desktop ? ["desktop"] : []),
          ],
          configuration: pkg.manifest.configuration,
        })),
      });
    }

    const notificationMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/notifications$/,
    );
    if (notificationMatch) {
      let notificationBotId: string;
      try {
        notificationBotId = decodeURIComponent(notificationMatch[1]);
      } catch {
        return jsonError(400, "invalid bot id");
      }
      if (!BOT_ID_PATTERN.test(notificationBotId)) {
        return jsonError(400, "invalid bot id");
      }
      if (request.method === "GET") {
        return Response.json({
          notifications:
            await env.BOT_STATE.listNotifications(notificationBotId),
        });
      }
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      const input: unknown = await request.json();
      const notificationId =
        typeof input === "object" &&
        input !== null &&
        "notificationId" in input &&
        typeof input.notificationId === "string"
          ? input.notificationId
          : undefined;
      if (!notificationId) {
        return jsonError(400, "notificationId is required");
      }
      await env.BOT_STATE.acknowledgeNotification(
        notificationBotId,
        notificationId,
      );
      return Response.json({ status: "acknowledged" });
    }

    const turnMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/turns$/);
    const reconcileMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/turns\/([^/]+)\/reconcile$/,
    );
    if (!turnMatch && !reconcileMatch) return jsonError(404, "not found");
    let botId: string;
    try {
      botId = decodeURIComponent((turnMatch ?? reconcileMatch)![1]);
    } catch {
      return jsonError(400, "invalid bot id");
    }
    if (!BOT_ID_PATTERN.test(botId)) return jsonError(400, "invalid bot id");

    if (reconcileMatch) {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      let runId: string;
      try {
        runId = decodeURIComponent(reconcileMatch[2]);
      } catch {
        return jsonError(400, "invalid run id");
      }
      if (!BOT_ID_PATTERN.test(runId)) return jsonError(400, "invalid run id");
      const input: unknown = await request.json();
      if (
        !input ||
        typeof input !== "object" ||
        !("action" in input) ||
        input.action !== "resume"
      ) {
        return jsonError(400, "reconciliation action is invalid");
      }
      try {
        return Response.json(await env.BOT_STATE.reconcileRun(botId, runId));
      } catch (error) {
        return jsonError(
          409,
          error instanceof Error ? error.message : "Reconciliation failed",
        );
      }
    }

    if (request.method === "GET") {
      return Response.json({ runs: await env.BOT_STATE.listRuns(botId) });
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");

    let turnCommand: { commandId: string; text: string };
    try {
      turnCommand = await readTurnCommand(request);
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error ? error.message : "invalid prompt",
      );
    }

    try {
      return Response.json(
        await env.BOT_STATE.run(botId, {
          runId: turnCommand.commandId,
          sessionId: `${env.DEPLOYMENT.userId}:${botId}`,
          acceptedAt: new Date().toISOString(),
          text: turnCommand.text,
        }),
      );
    } catch (error) {
      return jsonError(
        500,
        error instanceof Error ? error.message : "Bot turn failed",
      );
    }
  };
}

const fetchUserApplication = createUserApplication();

export default {
  fetch: fetchUserApplication,
} satisfies ExportedHandler<UserApplicationEnv>;
