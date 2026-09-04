import {
  createFoundationRuntimeApplication,
  isPlatformOwnedPackageV1,
} from "@frockbot/application-foundation/runtime";
import { foundationDefaultPackageIds } from "@frockbot/application-foundation/user";
import {
  decodeBotIdV1,
  isApplicationDeploymentHash,
  isRpcIdentifier,
} from "@frockbot/configuration-core";
import {
  APPLET_ID_V1,
  decodeAppletFocusViewV1,
  decodeAppletListViewV1,
  decodeAppletUiViewV1,
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
  type ClientTurnRefusalReasonV1,
  type ClientTurnRefusalV1,
} from "@frockbot/plugin-shell/run-protocol";
import { decodeApprovalDecisionCommandV1 } from "@frockbot/plugin-shell/approvals";
import { botTurnRefusalCodeV1 } from "@frockbot/kernel-do";
import type { UserApplicationEnv } from "./contracts.js";
import {
  VOICE_CAPTURE_WORKLET_PATH_V1,
  VOICE_CAPTURE_WORKLET_SOURCE_V1,
} from "@frockbot/plugin-shell/client/voice-worklet";
import { answeredEntryV1, entryFailureStatusV1 } from "./entry-boundary.js";
import {
  drainedAnswerV1,
  isRequestTooLargeV1,
  RequestTooLargeError,
  TURN_BODY_MAX_BYTES_V1,
  TURN_TOO_LONG_MESSAGE_V1,
  turnBodyIsOversizedV1,
} from "./request-body.js";

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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
  applicationUrl: URL,
): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set(
    "content-security-policy",
    // Package pages use the anonymous artifact origin. The expanded Computer
    // viewer frames the Sprite's own noVNC page (ADR 0004); both are optional
    // projections and neither becomes an authority in the hosted client. An
    // Applet's own UI is another page on the same artifact origin, nested by
    // the Applets canvas page, so the origin already named here covers it.
    `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ${applicationUrl.protocol === "https:" ? "wss:" : "ws:"}//${applicationUrl.host}; frame-src ${artifactOrigin} https://*.sprites.app; frame-ancestors 'none'; base-uri 'none'`,
  );
  return secured;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * A Bot-scoped call that failed, answered with the status the failure is owed.
 *
 * These routes check the registration once, at the top, and then talk to the
 * Bot Durable Object — and a Bot can stop existing in between. Deleting a Bot
 * makes that window real and routine: the panels of the Bot being looked at
 * poll it, so a read is almost always in flight when the delete lands. Such a
 * read is a 404 or a 410, not a server fault, and answering 500 made the
 * client log an error for the correct answer to its own question.
 *
 * Only a failure the entry boundary names gets a status of its own; anything
 * unrecognised is still this Worker's 500.
 */
function botFailure(error: unknown, fallback: string): Response {
  return jsonError(
    entryFailureStatusV1(error),
    error instanceof Error ? error.message : fallback,
  );
}

/**
 * A Turn the Bot Durable Object declined to admit, told apart from one that
 * broke.
 *
 * Admission refusals are ordinary, expected answers — the object is busy with
 * a Turn this command did not ask to replace, or is holding an uncertain
 * effect that has to be retrieved first, or the run was fenced. None of them
 * is a server fault, and answering 500 made the client log a console error for
 * something it should simply show the person. They are 409: the request was
 * well formed and the Bot's current state refuses it.
 */
const TURN_ADMISSION_REFUSALS_V1: readonly {
  match: RegExp;
  reason: ClientTurnRefusalReasonV1;
}[] = [
  { match: /bot already has an active run/i, reason: "busy" },
  {
    match: /requires reconciliation before/i,
    reason: "reconciliation-required",
  },
  { match: /admission was fenced/i, reason: "fenced" },
  { match: /already (exists|completed)/i, reason: "duplicate" },
];

export type { ClientTurnRefusalReasonV1, ClientTurnRefusalV1 };

function turnRefusal(error: unknown): ClientTurnRefusalV1 | undefined {
  const message = error instanceof Error ? error.message : "";
  // The typed refusal first: the authority names its own reason, and the name
  // is what survives the Durable Object RPC. The prose match stays as a
  // fallback for refusals a Package still raises as plain errors.
  const reason =
    botTurnRefusalCodeV1(error) ??
    TURN_ADMISSION_REFUSALS_V1.find((candidate) =>
      candidate.match.test(message),
    )?.reason;
  if (!reason) return undefined;
  return {
    schemaVersion: 1,
    status: "refused",
    reason,
    error: message,
  };
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
      if (error.name === "BotDeletedError")
        return jsonError(
          410,
          error instanceof Error ? error.message : "Bot is deleted",
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

/**
 * Read a send, refusing an oversized one before the body is touched.
 *
 * The refusal is typed rather than prose so the route can answer 413 with the
 * sentence the composer shows, and so it is told apart from a body that simply
 * would not parse. The gateway checks the same length one isolate earlier;
 * this check is the one that holds however else a request reaches this Worker.
 */
async function readTurnCommand(request: Request): Promise<ClientTurnCommandV1> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > TURN_BODY_MAX_BYTES_V1) {
    throw new RequestTooLargeError();
  }
  try {
    return decodeClientTurnCommandV1(await request.json());
  } catch (error) {
    // The decoder's own bound on `text`. Same refusal, said the same way: a
    // body under the wire limit can still carry a message over the text one.
    if (
      error instanceof Error &&
      /turn command\.text\b.*\b(exceeds|too long|too large)/i.test(
        error.message,
      )
    ) {
      throw new RequestTooLargeError();
    }
    throw error;
  }
}

export function createUserApplication() {
  const route = createUserApplicationRoute();
  /*
   * The User application's own outermost wrapper.
   *
   * This Worker is loaded into its own isolate and receives its own `Request`,
   * so the gateway's drain does nothing for it: an early return here — a 404
   * on a POST, a body refused for its size — is exactly the shape that makes
   * workerd tear the isolate down with "Can't read from request stream after
   * response has been sent". Every answer passes through the drain, and the
   * size refusal is given before any route runs so an oversized send is never
   * parsed.
   */
  return async (
    request: Request,
    env: UserApplicationEnv,
  ): Promise<Response> => {
    let oversized = false;
    try {
      oversized = turnBodyIsOversizedV1(request, new URL(request.url));
    } catch {
      // An unparseable URL is the route's 400 to give, not this guard's.
    }
    if (oversized) {
      return drainedAnswerV1(request, jsonError(413, TURN_TOO_LONG_MESSAGE_V1));
    }
    // This Worker's `fetch` is an entry point of its own: a route that throws
    // has no caller left inside the isolate, and the log showed exactly that —
    // `BotNotFoundError` five times in one window, then a refused Turn, then
    // the process exiting. A Bot that is not there is a 404 the client can act
    // on; anything else is a 500 that still carries a readable reason, and the
    // isolate survives to answer the next request.
    return drainedAnswerV1(
      request,
      await answeredEntryV1("request failed", () => route(request, env)),
    );
  };
}

function createUserApplicationRoute() {
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
        url,
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
        url,
      );
    }
    // The composer's dictation worklet. A first-party asset rather than a
    // blob URL because the page is served under `script-src 'self'`, which a
    // blob module does not satisfy; the alternative was widening that policy
    // for every script to load one file. See `plugin-shell/.../voice-worklet.ts`.
    if (
      request.method === "GET" &&
      url.pathname === VOICE_CAPTURE_WORKLET_PATH_V1
    ) {
      return withSecurityHeaders(
        new Response(VOICE_CAPTURE_WORKLET_SOURCE_V1, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
          },
        }),
        packageUiArtifactOrigin(url),
        url,
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
        url,
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
        url,
      );
    }
    if (request.method === "GET" && url.pathname === "/app-manifest") {
      const compiled = await application;
      const defaultPackageIds = foundationDefaultPackageIds(compiled.plan);
      return Response.json({
        schemaVersion: 1,
        deployment: env.DEPLOYMENT,
        applicationHash: compiled.plan.applicationHash,
        // The client needs model-provider manifest facts even when a Package
        // is platform-owned. The backend therefore projects every Package and
        // marks the ownership decision it derived from immutable manifest
        // facts; enablement surfaces omit those rows while model resolution
        // still sees them.
        packages: compiled.plan.packages.map((pkg) => ({
          id: pkg.id,
          displayName: pkg.manifest.displayName,
          version: pkg.version,
          platformOwned: isPlatformOwnedPackageV1(
            pkg.manifest,
            defaultPackageIds.has(pkg.id),
          ),
          contributions: [
            ...(pkg.manifest.contributions.backend ? ["backend"] : []),
            ...(pkg.manifest.contributions.runtime ? ["runtime"] : []),
            ...(pkg.manifest.contributions.client ? ["client"] : []),
            ...(pkg.manifest.contributions.desktop ? ["desktop"] : []),
            ...(pkg.manifest.contributions.mobile ? ["mobile"] : []),
          ],
          configuration: pkg.manifest.configuration,
        })),
      });
    }

    // --- Applets (ADR 0022 §4) ---------------------------------------------
    //
    // Session-authenticated and User-scoped: the gateway has already proved who
    // is asking, and an Applet belongs to the User rather than to a Bot. The
    // token these mint is the only credential an Applet page ever holds, and it
    // names one User, one Applet, and one generation for fifteen minutes.
    if (url.pathname === "/api/applets") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      try {
        // Projected through the view decoder the client uses, so the two sides
        // cannot disagree: the durable answer carries a `revision` the view
        // does not declare, and an exact-keys decoder is right to refuse it.
        const listed = (await env.BOT_STATE.listApplets()) as {
          applets: unknown;
        };
        return Response.json(
          decodeAppletListViewV1({
            schemaVersion: 1,
            applets: listed.applets,
          }),
        );
      } catch (error) {
        return jsonError(
          503,
          error instanceof Error ? error.message : "Applets are unavailable",
        );
      }
    }
    const appletTokenMatch = url.pathname.match(
      /^\/api\/applets\/([^/]+)\/token$/,
    );
    const appletUiMatch = url.pathname.match(/^\/api\/applets\/([^/]+)\/ui$/);
    if (appletTokenMatch || appletUiMatch) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      let appletId: string;
      try {
        appletId = decodeURIComponent((appletTokenMatch ?? appletUiMatch)![1]);
      } catch {
        return jsonError(400, "invalid applet id");
      }
      try {
        if (appletUiMatch) {
          const ui = await env.BOT_STATE.readAppletUi({
            schemaVersion: 1,
            appletId,
          });
          return Response.json(
            decodeAppletUiViewV1({
              // The anonymous artifact origin, exactly as a Package page is
              // served: the Applet's UI is immutable content addressed by hash.
              uiUrl: `${packageUiArtifactOrigin(url)}/packages/${ui.contentHash}.html`,
              ...(ui.generationId === undefined
                ? {}
                : { generationId: ui.generationId }),
            }),
          );
        }
        const minted = await env.BOT_STATE.mintAppletViewerToken({
          schemaVersion: 1,
          appletId,
        });
        const socket = new URL(url.origin);
        socket.protocol = url.protocol === "http:" ? "ws:" : "wss:";
        socket.pathname = `/api/applets/${encodeURIComponent(appletId)}/socket`;
        socket.searchParams.set("token", minted.token);
        return Response.json({
          token: minted.token,
          expiresAt: minted.expiresAt,
          socketUrl: socket.toString(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Applet is unavailable";
        return jsonError(
          message.includes("unavailable") || message.includes("no active")
            ? 404
            : 503,
          message,
        );
      }
    }
    const appletFocusMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/applets\/focus$/,
    );
    if (appletFocusMatch) {
      let focusBotId: string;
      try {
        focusBotId = decodeBotIdV1(decodeURIComponent(appletFocusMatch[1]));
      } catch {
        return jsonError(400, "invalid bot id");
      }
      const missing = await requireRegisteredBot(env, focusBotId);
      if (missing) return missing;
      try {
        if (request.method === "GET") {
          // Projected to the view, not the record. `FocusedAppletV1` carries
          // `changedAt`, which is durable bookkeeping; `AppletFocusViewV1` is
          // exactly `{ appletId }` and its decoder refuses an extra field, so
          // handing the record over the wire made every read fail closed and
          // the canvas never opened.
          const focused = (await env.BOT_STATE.readFocusedApplet({
            schemaVersion: 1,
            botId: focusBotId,
          })) as { appletId: string | null };
          return Response.json(
            decodeAppletFocusViewV1({ appletId: focused.appletId }),
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const body = (await request.json()) as { appletId?: unknown };
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("appletId" in body) ||
          (body.appletId !== null && typeof body.appletId !== "string")
        ) {
          return jsonError(400, "focus command is invalid");
        }
        const recorded = (await env.BOT_STATE.setFocusedApplet({
          schemaVersion: 1,
          botId: focusBotId,
          appletId: body.appletId,
        })) as { appletId: string | null };
        return Response.json(
          decodeAppletFocusViewV1({ appletId: recorded.appletId }),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Applet focus failed",
        );
      }
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
          return botFailure(error, "approvals failed");
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
    const appletSourceMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/applets\/([^/]+)\/source$/,
    );
    const appletBuildMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/applets\/([^/]+)\/build$/,
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
    const conversationsMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/conversations$/,
    );
    if (
      !conversationsMatch &&
      !skillsMatch &&
      !packageUiMatch &&
      !packageUiToolMatch &&
      !appletSourceMatch &&
      !appletBuildMatch &&
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
        conversationsMatch ??
        skillsMatch ??
        packageUiMatch ??
        packageUiToolMatch ??
        appletSourceMatch ??
        appletBuildMatch ??
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
        return botFailure(error, "skill catalog failed");
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
        return botFailure(error, "Package UI catalog failed");
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

    if (appletSourceMatch || appletBuildMatch) {
      // The Applet canvas's two reads. Both answer from the Workspace store
      // and the Bot Durable Object's own records, so a hibernated Computer
      // stays hibernated: rendering what a Bot wrote never wakes the machine
      // it wrote it on.
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      let appletId: string;
      try {
        appletId = decodeURIComponent(
          (appletSourceMatch ?? appletBuildMatch)![2],
        );
      } catch {
        return jsonError(400, "invalid applet id");
      }
      if (!APPLET_ID_V1.test(appletId)) {
        return jsonError(400, "invalid applet id");
      }
      try {
        return Response.json(
          appletSourceMatch
            ? await env.BOT_STATE.readAppletSourceV1({
                schemaVersion: 1,
                botId,
                appletId,
              })
            : await env.BOT_STATE.readAppletBuildV1({
                schemaVersion: 1,
                botId,
                appletId,
              }),
        );
      } catch (error) {
        return botFailure(error, "Applet read failed");
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
        return botFailure(error, "admission fence failed");
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

    if (conversationsMatch) {
      // GET lists the conversations this Bot has had; POST puts the current
      // one down and starts the next. Both answer with the same list, so the
      // client never has to ask twice to know where it is.
      if (request.method === "GET") {
        try {
          return Response.json(
            await env.BOT_STATE.listConversations({ schemaVersion: 1, botId }),
          );
        } catch (error) {
          return botFailure(error, "conversation list failed");
        }
      }
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        // A Bot that is mid-Turn refuses, with the reason: 409 is the same
        // "not now" the composer already understands. It arrives as a value,
        // not an exception — a throw here would have crossed a Durable Object
        // boundary to get here, and workerd logs such a crossing as an
        // uncaught error and has been seen to take the isolate down with it.
        const outcome = await env.BOT_STATE.startConversation({
          schemaVersion: 1,
          botId,
        });
        if (outcome.status === "refused") {
          return jsonError(409, outcome.reason);
        }
        const { status: _status, ...list } = outcome;
        return Response.json(list);
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error
            ? error.message
            : "could not start a new conversation",
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
        return botFailure(error, "run lookup failed");
      }
    }

    if (request.method === "GET") {
      let query;
      try {
        const queryKeys = [...url.searchParams.keys()];
        if (
          queryKeys.some(
            (key) => key !== "before" && key !== "conversationId",
          ) ||
          url.searchParams.getAll("before").length > 1 ||
          url.searchParams.getAll("conversationId").length > 1
        ) {
          throw new Error("run list query is invalid");
        }
        const before = url.searchParams.get("before");
        const conversationId = url.searchParams.get("conversationId");
        query = decodeClientRunListQueryV1({
          schemaVersion: 1,
          ...(before === null ? {} : { before }),
          ...(conversationId === null ? {} : { conversationId }),
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
        return botFailure(error, "run list failed");
      }
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");

    let turnCommand: ClientTurnCommandV1;
    try {
      turnCommand = await readTurnCommand(request);
    } catch (error) {
      if (isRequestTooLargeV1(error)) {
        return jsonError(413, TURN_TOO_LONG_MESSAGE_V1);
      }
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
            // The composer's explicit authenticated intent to replace whatever
            // the Bot is doing. It is forwarded exactly as sent — including
            // the empty form, which means the sender had observed no run —
            // because its presence is the decision. The lane is `user`
            // because only the composer reaches this route.
            ...(turnCommand.supersedes
              ? { supersedes: turnCommand.supersedes, lane: "user" as const }
              : {}),
          },
        }),
      );
    } catch (error) {
      const refusal = turnRefusal(error);
      if (refusal) return Response.json(refusal, { status: 409 });
      return botFailure(error, "Bot turn failed");
    }
  };
}

const fetchUserApplication = createUserApplication();

export default {
  fetch: fetchUserApplication,
} satisfies ExportedHandler<UserApplicationEnv>;
