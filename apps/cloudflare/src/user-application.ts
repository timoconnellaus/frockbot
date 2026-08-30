import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import { decodeBotIdV1 } from "@frockbot/configuration-core";
import type {
  ClientNotificationAcknowledgementV1,
  ClientNotificationListV1,
} from "@frockbot/client-core";
import {
  decodeClientNotificationAcknowledgementCommandV1,
  decodeClientRunAdmissionFenceCommandV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunListQueryV1,
  decodeClientRunReconciliationCommandV1,
  decodeClientTurnCommandV1,
  type ClientRunLookupQueryV1,
  type ClientTurnCommandV1,
} from "@frockbot/plugin-shell/run-protocol";
import type { UserApplicationEnv } from "./contracts.js";

const RPC_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;
const USER_ID_PATTERN = RPC_ID_PATTERN;
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
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors capacitor://localhost frockbot://localhost; base-uri 'none'",
  );
  return secured;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function requireRegisteredBot(
  env: UserApplicationEnv,
  botId: string,
): Promise<Response | undefined> {
  try {
    await env.BOT_STATE.assertRegistered({ schemaVersion: 1, botId });
    return undefined;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "BotNotFoundError"
    )
      return jsonError(
        404,
        error instanceof Error ? error.message : "Bot not found",
      );
    return jsonError(
      503,
      error instanceof Error
        ? error.message
        : "Bot registration is temporarily unavailable",
    );
  }
}

async function readTurnCommand(request: Request): Promise<ClientTurnCommandV1> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INPUT_LENGTH * 2) {
    throw new Error("prompt is too large");
  }
  return decodeClientTurnCommandV1(await request.json());
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
      try {
        notificationBotId = decodeBotIdV1(notificationBotId);
      } catch {
        return jsonError(400, "invalid bot id");
      }
      const missingBot = await requireRegisteredBot(env, notificationBotId);
      if (missingBot) return missingBot;
      if (request.method === "GET") {
        return Response.json({
          schemaVersion: 1,
          notifications: await env.BOT_STATE.listNotifications({
            schemaVersion: 1,
            botId: notificationBotId,
          }),
        } satisfies ClientNotificationListV1);
      }
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let command;
      try {
        command = decodeClientNotificationAcknowledgementCommandV1(
          await request.json(),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error
            ? error.message
            : "invalid notification acknowledgement",
        );
      }
      await env.BOT_STATE.acknowledgeNotification({
        schemaVersion: 1,
        botId: notificationBotId,
        notificationId: command.notificationId,
      });
      return Response.json({
        schemaVersion: 1,
        status: "acknowledged",
      } satisfies ClientNotificationAcknowledgementV1);
    }

    const turnMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/turns$/);
    const lookupMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/turns\/([^/]+)$/,
    );
    const reconcileMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/turns\/([^/]+)\/reconcile$/,
    );
    const fenceMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/turns\/([^/]+)\/fence$/,
    );
    if (!turnMatch && !lookupMatch && !reconcileMatch && !fenceMatch) {
      return jsonError(404, "not found");
    }
    let botId: string;
    try {
      botId = decodeURIComponent(
        (turnMatch ?? lookupMatch ?? reconcileMatch ?? fenceMatch)![1],
      );
    } catch {
      return jsonError(400, "invalid bot id");
    }
    try {
      botId = decodeBotIdV1(botId);
    } catch {
      return jsonError(400, "invalid bot id");
    }
    const missingBot = await requireRegisteredBot(env, botId);
    if (missingBot) return missingBot;

    if (reconcileMatch) {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      let runId: string;
      try {
        runId = decodeURIComponent(reconcileMatch[2]);
      } catch {
        return jsonError(400, "invalid run id");
      }
      if (!RPC_ID_PATTERN.test(runId)) return jsonError(400, "invalid run id");
      try {
        decodeClientRunReconciliationCommandV1(await request.json());
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error
            ? error.message
            : "reconciliation action is invalid",
        );
      }
      try {
        return Response.json(
          await env.BOT_STATE.reconcileRun({
            schemaVersion: 1,
            botId,
            runId,
          }),
        );
      } catch (error) {
        return jsonError(
          409,
          error instanceof Error ? error.message : "Reconciliation failed",
        );
      }
    }

    if (fenceMatch) {
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let query: ClientRunLookupQueryV1;
      try {
        decodeClientRunAdmissionFenceCommandV1(await request.json());
        query = decodeClientRunLookupQueryV1({
          schemaVersion: 1,
          runId: decodeURIComponent(fenceMatch[2]),
        });
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid admission fence",
        );
      }
      try {
        return Response.json(
          await env.BOT_STATE.fenceRunAdmission({
            schemaVersion: 1,
            botId,
            query,
          }),
        );
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "admission fence failed",
        );
      }
    }

    if (lookupMatch) {
      if (request.method !== "GET") {
        return jsonError(405, "method not allowed");
      }
      let query: ClientRunLookupQueryV1;
      try {
        if ([...url.searchParams.keys()].length > 0) {
          throw new Error("run lookup query does not accept URL parameters");
        }
        query = decodeClientRunLookupQueryV1({
          schemaVersion: 1,
          runId: decodeURIComponent(lookupMatch[2]),
        });
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid run lookup",
        );
      }
      try {
        return Response.json(
          await env.BOT_STATE.lookupRun({ schemaVersion: 1, botId, query }),
        );
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "run lookup failed",
        );
      }
    }

    if (request.method === "GET") {
      let query;
      try {
        const queryKeys = [...url.searchParams.keys()];
        if (
          queryKeys.some((key) => key !== "before") ||
          url.searchParams.getAll("before").length > 1
        ) {
          throw new Error("run list query is invalid");
        }
        const before = url.searchParams.get("before");
        query = decodeClientRunListQueryV1({
          schemaVersion: 1,
          ...(before === null ? {} : { before }),
        });
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid run page",
        );
      }
      return Response.json(
        await env.BOT_STATE.listRuns({ schemaVersion: 1, botId, query }),
      );
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
        await env.BOT_STATE.run({
          schemaVersion: 1,
          botId,
          command: {
            runId: turnCommand.commandId,
            sessionId: `${env.DEPLOYMENT.userId}:${botId}`,
            acceptedAt: new Date().toISOString(),
            text: turnCommand.text,
          },
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
