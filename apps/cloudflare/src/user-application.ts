import {
  createFoundationRuntimeApplication,
  isUserInstallablePackageV1,
} from "@frockbot/application-foundation/runtime";
import {
  decodeBotIdV1,
  isApplicationDeploymentHash,
  isRpcIdentifier,
} from "@frockbot/configuration-core";
import {
  decodePackageIframeToolCommandV1,
  type PackageIframeCatalogV1,
} from "@frockbot/kernel-contracts";
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
import { decodeApprovalDecisionCommandV1 } from "@frockbot/plugin-shell/approvals";
import type { UserApplicationEnv } from "./contracts.js";

const MAX_INPUT_LENGTH = 32_000;

declare const __FROCKBOT_CLIENT_JS__: string;
declare const __FROCKBOT_CLIENT_CSS__: string;
declare const __FROCKBOT_CLIENT_ICON__: string;

const APP_JS =
  typeof __FROCKBOT_CLIENT_JS__ === "string"
    ? __FROCKBOT_CLIENT_JS__
    : "throw new Error('Worker renderer was not bundled')";
const APP_CSS =
  typeof __FROCKBOT_CLIENT_CSS__ === "string" ? __FROCKBOT_CLIENT_CSS__ : "";
// The site icon is a PNG, so it rides the artifact as base64 and is decoded
// once at module scope rather than on every request.
const APP_ICON = Uint8Array.from(
  atob(
    typeof __FROCKBOT_CLIENT_ICON__ === "string"
      ? __FROCKBOT_CLIENT_ICON__
      : "",
  ),
  (character) => character.charCodeAt(0),
);

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

function hostedIsAdmin(request: Request): boolean {
  const value = request.headers.get("x-frockbot-is-admin-v1");
  if (value !== "true" && value !== "false") {
    throw new Error("hosted admin projection is invalid");
  }
  return value === "true";
}

/**
 * The `<body>` attributes the hosted client's auth projection decodes
 * (`packages/plugin-auth/src/client/browser.ts`, which throws rather than
 * mounting when one is missing). Every document that mounts the client - the
 * Worker-rendered one below and the vite development document
 * (`apps/cloudflare/index.html`) - carries all of them, so the list lives in
 * one place and both documents are tested against it.
 */
export const HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1 = [
  "data-frockbot-user-id",
  "data-frockbot-auth-mode",
  "data-frockbot-is-admin",
] as const;

function appHtml(
  userId: string,
  applicationHash: string,
  authMode: HostedAuthModeV1,
  isAdmin: boolean,
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
  <link rel="icon" type="image/png" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/favicon.ico">
  <link rel="stylesheet" href="/app.css">
</head>
<body data-frockbot-user-id="${userId}" data-frockbot-user-application="${applicationHash}" data-frockbot-auth-mode="${authMode}" data-frockbot-is-admin="${String(isAdmin)}">
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

function packageUiArtifactOrigin(requestUrl: URL): string {
  const appHost = requestUrl.hostname;
  const host =
    appHost === "localhost" || appHost === "127.0.0.1"
      ? "ui.localhost"
      : appHost.startsWith("ui.")
        ? appHost
        : `ui.${appHost}`;
  return `${requestUrl.protocol}//${host}${requestUrl.port ? `:${requestUrl.port}` : ""}`;
}

function withSecurityHeaders(
  response: Response,
  artifactOrigin: string,
): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set(
    "content-security-policy",
    // Package pages use the anonymous artifact origin. The expanded Computer
    // viewer frames the Sprite's own noVNC page (ADR 0004); both are optional
    // projections and neither becomes an authority in the hosted client.
    `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-src ${artifactOrigin} https://*.sprites.app; frame-ancestors 'none'; base-uri 'none'`,
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
            hostedIsAdmin(request),
          ),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
        packageUiArtifactOrigin(url),
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
        packageUiArtifactOrigin(url),
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
        packageUiArtifactOrigin(url),
      );
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      // Browsers request `/favicon.ico` by convention even when a link element
      // names it, so the site icon answers on that one path in its real type.
      return withSecurityHeaders(
        new Response(APP_ICON, {
          headers: {
            "content-type": "image/png",
            "cache-control": "no-cache",
          },
        }),
        packageUiArtifactOrigin(url),
      );
    }
    if (request.method === "GET" && url.pathname === "/app-manifest") {
      const compiled = await application;
      return Response.json({
        schemaVersion: 1,
        deployment: env.DEPLOYMENT,
        applicationHash: compiled.plan.applicationHash,
        // The catalog is what a User can install. The application's own shell
        // is mounted unconditionally and was never installed, so it is not
        // offered as a choice; everything else stays listed, including a
        // Package whose only Capabilities are tools that need no Connection.
        packages: compiled.plan.packages
          .filter((pkg) => isUserInstallablePackageV1(pkg.manifest))
          .map((pkg) => ({
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

    // Approval cards (row 53). Bot-scoped and beside the notifications route,
    // because a pending decision is Bot state the User answers, not a Package
    // surface of its own.
    const approvalsMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/approvals$/,
    );
    const approvalMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/approvals\/([^/]+)$/,
    );
    if (approvalsMatch || approvalMatch) {
      let approvalBotId: string;
      try {
        approvalBotId = decodeBotIdV1(
          decodeURIComponent((approvalsMatch ?? approvalMatch)![1]),
        );
      } catch {
        return jsonError(400, "invalid bot id");
      }
      const missing = await requireRegisteredBot(env, approvalBotId);
      if (missing) return missing;
      if (approvalsMatch) {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        try {
          return Response.json(
            await env.BOT_STATE.listApprovals({
              schemaVersion: 1,
              botId: approvalBotId,
            }),
          );
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "approvals failed",
          );
        }
      }
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let approvalId: string;
      let command;
      try {
        approvalId = decodeURIComponent(approvalMatch![2]);
        if (!isRpcIdentifier(approvalId)) {
          throw new Error("approval id is invalid");
        }
        command = decodeApprovalDecisionCommandV1(await request.json());
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid approval decision",
        );
      }
      try {
        // The decision is durable before this answers: "admit input durably
        // before acknowledging" applies to a person's answer as much as to a
        // Turn's, and a replay reads back the one decision that was recorded.
        return Response.json(
          await env.BOT_STATE.decideApproval({
            schemaVersion: 1,
            botId: approvalBotId,
            approvalId,
            command,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "approval decision failed";
        return jsonError(
          message.includes("was not found") ? 404 : 500,
          message,
        );
      }
    }

    const skillsMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/skills$/);
    const packageUiMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/package-ui$/,
    );
    const packageUiToolMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/package-ui\/tools$/,
    );
    const workspaceFileMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/workspace\/file$/,
    );
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
      !skillsMatch &&
      !packageUiMatch &&
      !packageUiToolMatch &&
      !workspaceFileMatch &&
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
        skillsMatch ??
        packageUiMatch ??
        packageUiToolMatch ??
        workspaceFileMatch ??
        turnMatch ??
        lookupMatch ??
        reconcileMatch ??
        fenceMatch ??
        stopMatch;
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

    if (skillsMatch) {
      // Read-only, and named refs only: the popover learns which Skills exist
      // and never receives a body.
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      try {
        return Response.json(
          await env.BOT_STATE.listSkills({ schemaVersion: 1, botId }),
        );
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "skill catalog failed",
        );
      }
    }

    if (packageUiMatch) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      try {
        const composition = await env.BOT_STATE.listPackageUi({
          schemaVersion: 1,
          botId,
        });
        return Response.json({
          ...composition,
          artifactOrigin: packageUiArtifactOrigin(url),
        } satisfies PackageIframeCatalogV1);
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "Package UI catalog failed",
        );
      }
    }

    if (packageUiToolMatch) {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        const command = decodePackageIframeToolCommandV1(await request.json());
        return Response.json(
          await env.BOT_STATE.runPackageUiTool({
            schemaVersion: 1,
            botId,
            command,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Package UI tool call failed";
        return jsonError(
          message.includes("did not declare") ? 403 : 409,
          message,
        );
      }
    }

    if (workspaceFileMatch) {
      // Read-only, and the durable root and path arrive as one encoded
      // `WorkspacePathV1` so the route cannot assemble a root the decoder
      // would not accept. The bytes come from object storage; no Computer
      // wakes to serve this.
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      const encoded = url.searchParams.get("path");
      if (!encoded) return jsonError(400, "a workspace path is required");
      let path: unknown;
      try {
        path = JSON.parse(encoded);
      } catch {
        return jsonError(400, "invalid workspace path");
      }
      try {
        const answer = await env.BOT_STATE.readWorkspaceFileV1({
          schemaVersion: 1,
          botId,
          path,
        });
        if (answer.status !== "ok") {
          return jsonError(
            answer.status === "not-found" ? 404 : 409,
            "reason" in answer ? answer.reason : "workspace read failed",
          );
        }
        const binary = atob(answer.bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "private, max-age=60",
            etag: `"${answer.contentHash}"`,
          },
        });
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "workspace read failed",
        );
      }
    }

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

    let turnCommand: ClientTurnCommandV1;
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
            // Refs only: the client names a Skill and never carries its text,
            // so what a Turn runs on is still whatever the instruction root
            // holds at the generation the Turn resolves.
            ...(turnCommand.skills ? { skills: turnCommand.skills } : {}),
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
