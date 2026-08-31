import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import {
  decodeBotIdV1,
  isApplicationDeploymentHash,
  isRpcIdentifier,
} from "@frockbot/configuration-core";
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
  decodeClientRunStopCommandV1,
  decodeClientTurnCommandV1,
  type ClientRunLookupQueryV1,
  type ClientRunStopCommandV1,
  type ClientTurnCommandV1,
} from "@frockbot/plugin-shell/run-protocol";
import type { UserApplicationEnv } from "./contracts.js";

const MAX_INPUT_LENGTH = 32_000;

declare const __FROCKBOT_CLIENT_JS__: string;
declare const __FROCKBOT_CLIENT_CSS__: string;

const APP_JS =
  typeof __FROCKBOT_CLIENT_JS__ === "string"
    ? __FROCKBOT_CLIENT_JS__
    : "throw new Error('Worker renderer was not bundled')";
const APP_CSS =
  typeof __FROCKBOT_CLIENT_CSS__ === "string" ? __FROCKBOT_CLIENT_CSS__ : "";

type HostedAuthModeV1 = "anonymous" | "better-auth" | "development";

function hostedAuthMode(request: Request): HostedAuthModeV1 {
  const mode = request.headers.get("x-frockbot-auth-session-v1");
  if (
    mode !== "anonymous" &&
    mode !== "better-auth" &&
    mode !== "development"
  ) {
    throw new Error("hosted auth session projection is invalid");
  }
  return mode;
}

function appHtml(
  userId: string,
  applicationHash: string,
  authMode: HostedAuthModeV1,
): string {
  if (!isRpcIdentifier(userId)) throw new Error("invalid user id");
  if (!isApplicationDeploymentHash(applicationHash)) {
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
<body data-frockbot-user-id="${userId}" data-frockbot-user-application="${applicationHash}" data-frockbot-auth-mode="${authMode}">
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
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    if (typeof error === "object" && error !== null && "name" in error) {
      if (error.name === "BotNotFoundError")
        return jsonError(
          404,
          error instanceof Error ? error.message : "Bot not found",
        );
      if (error.name === "BotArchivedError")
        return jsonError(
          409,
          error instanceof Error ? error.message : "Bot is archived",
        );
    }
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
          appHtml(
            env.DEPLOYMENT.userId,
            env.DEPLOYMENT.applicationHash,
            hostedAuthMode(request),
          ),
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
    const stopMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/turns\/([^/]+)\/stop$/,
    );
    if (
      !turnMatch &&
      !lookupMatch &&
      !reconcileMatch &&
      !fenceMatch &&
      !stopMatch
    ) {
      return jsonError(404, "not found");
    }
    let botId: string;
    try {
      const matched =
        turnMatch ?? lookupMatch ?? reconcileMatch ?? fenceMatch ?? stopMatch;
      botId = decodeURIComponent(matched![1]);
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
      if (!isRpcIdentifier(runId)) return jsonError(400, "invalid run id");
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

    if (stopMatch) {
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let command: ClientRunStopCommandV1;
      try {
        const body: unknown = await request.json();
        command = decodeClientRunStopCommandV1(body);
        if (command.runId !== decodeURIComponent(stopMatch[2])) {
          throw new Error("run stop command does not match the request path");
        }
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid stop command",
        );
      }
      try {
        return Response.json(
          await env.BOT_STATE.stopRun({ schemaVersion: 1, botId, command }),
        );
      } catch (error) {
        return jsonError(
          409,
          error instanceof Error ? error.message : "Stop failed",
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
      try {
        return Response.json(
          await env.BOT_STATE.listRuns({ schemaVersion: 1, botId, query }),
        );
      } catch (error) {
        // A stored run the current codec refuses is a visible failure with
        // its reason, never a crash of the whole application Worker.
        return jsonError(
          500,
          error instanceof Error ? error.message : "run list failed",
        );
      }
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
        // Every Turn a client asks for is admitted as `chat`. The turn type is
        // never carried here: `decodeClientTurnCommandV1` accepts exact keys,
        // and the Bot Durable Object's run RPC accepts exact keys too, so a
        // client cannot name one, and an absent turn type means `chat`. Only an
        // in-Durable-Object producer may admit another type.
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
