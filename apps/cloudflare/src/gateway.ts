import {
  ConfigurationConflictError,
  ConfigurationDecodeError,
  decodeBotIdV1,
  decodeBotSettingsViewV1,
  decodeConfigurationCommandV1,
  decodeConfigurationQueryV1,
  decodeOperationReceiptV1,
  decodeUserSettingsViewV1,
  isApplicationDeploymentHash,
  isPublicIdentifier,
} from "@frockbot/configuration-core";
import { decodeDeploymentPolicyV1 } from "@frockbot/plugin-admin/shared";
import {
  AppletViewerTokenError,
  verifyAppletViewerTokenV1,
} from "@frockbot/kernel-do";
import { isDeploymentAdminV1 } from "./admin-identities.js";
import type {
  CatalogGatewayDocument,
  CatalogGatewayStore,
  GatewayDependencies,
  UserApplicationIdentity,
  WorkerCode,
} from "./contracts.js";
import { createDebugRoute } from "./debug.js";
import {
  drainedAnswerV1,
  forwardingBodyV1,
  TURN_TOO_LONG_MESSAGE_V1,
  turnBodyIsOversizedV1,
} from "./request-body.js";

const PUBLIC_APPLICATION_USER_ID = "anonymous";
const PUBLIC_ASSET_PATHS = new Set([
  "/",
  "/app.js",
  "/app.css",
  "/favicon.ico",
]);
const PACKAGE_UI_PATH = /^\/packages\/([0-9a-f]{64})\.html$/;
export const PACKAGE_UI_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * The gateway origin an artifact host belongs to: `ui.bot.example` serves the
 * pages of `bot.example`.
 *
 * An Applet's page opens a WebSocket back to its own account's gateway and to
 * nothing else, so the `connect-src` it is served with is derived here rather
 * than widened to a wildcard. Every other Package page is unaffected: it simply
 * gains a `connect-src` it does not use.
 */
export function packageUiGatewayOriginV1(url: URL): string {
  const host = url.hostname.startsWith("ui.")
    ? url.hostname.slice("ui.".length)
    : url.hostname;
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${host}${port}`;
}

/**
 * What a Package page may do.
 *
 * Still `default-src 'none'`: a page loads nothing from anywhere, and its
 * script and style are the inline ones in the artifact itself. Two openings,
 * both named rather than wildcarded, and both derived from the request so a
 * deployment on any hostname gets exactly its own:
 *
 * - `connect-src <gateway origin> <gateway ws origin>` lets an Applet's UI open
 *   its viewer socket back to the `AppletState` object on the gateway, which
 *   is the only endpoint it is given (ADR 0022 §4).
 * - `frame-src <artifact origin>` lets a page nest another page on the same
 *   anonymous origin — the Applets canvas page nesting the Applet's own UI.
 *   The nested frame is served by this very route, with this very policy.
 *
 * No `frame-ancestors` relaxation and no `form-action`.
 */
export function packageUiCspV1(url: URL): string {
  const origin = packageUiGatewayOriginV1(url);
  const origins = [origin];
  // Local development serves the app on `localhost` or `127.0.0.1` and both
  // map to the one `ui.localhost` artifact host, so a page there may connect
  // to either spelling of the loopback gateway. A deployed host maps to
  // exactly one origin.
  if (new URL(origin).hostname === "localhost") {
    origins.push(origin.replace("//localhost", "//127.0.0.1"));
  }
  const connect = origins
    .flatMap((candidate) => [candidate, candidate.replace(/^http/, "ws")])
    .join(" ");
  return `${PACKAGE_UI_CSP}; connect-src ${connect}; frame-src ${url.origin}`;
}
export const SIGNUPS_CLOSED_MESSAGE =
  "FrockBot isn't taking new signups right now.";

export function applicationDeploymentId(
  identity: UserApplicationIdentity,
): string {
  if (!isPublicIdentifier(identity.userId)) {
    throw new Error("invalid user id");
  }
  if (!isApplicationDeploymentHash(identity.applicationHash)) {
    throw new Error("invalid application hash");
  }
  return `${identity.userId}:${identity.applicationHash}`;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** Anonymous immutable artifact route. A configured UI host serves nothing else. */
export async function servePackageUiArtifact(
  request: Request,
  url: URL,
  artifacts: GatewayDependencies["artifacts"],
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method not allowed");
  }
  const match = url.pathname.match(PACKAGE_UI_PATH);
  if (!match) return jsonError(404, "UI artifact was not found");
  if (!artifacts.loadPackageUiArtifact) {
    return jsonError(503, "Package UI artifacts are not configured");
  }
  const contentHash = match[1]!;
  let html: string | undefined;
  try {
    html = await artifacts.loadPackageUiArtifact(contentHash);
  } catch {
    return jsonError(502, "UI artifact failed verification");
  }
  if (html === undefined) return jsonError(404, "UI artifact was not found");
  const etag = `"${contentHash}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": packageUiCspV1(url),
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : html, { headers });
}

function signupClosedResponse(request: Request, url: URL): Response {
  if (request.method !== "GET" || url.pathname !== "/") {
    return jsonError(403, SIGNUPS_CLOSED_MESSAGE);
  }
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FrockBot</title>
</head>
<body>
  <main>
    <p>FrockBot</p>
    <h1>${SIGNUPS_CLOSED_MESSAGE}</h1>
    <p>If you already have access, ask whoever invited you to check your sign-in email.</p>
    <a href="/sign-out">Sign out</a>
  </main>
</body>
</html>`,
    {
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function routeSignOut(
  request: Request,
  url: URL,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  const response = await dependencies.auth.handler(
    new Request(new URL("/api/auth/sign-out", url), {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
  if (!response.ok) return response;
  const redirect = new Response(null, {
    status: 303,
    headers: response.headers,
  });
  redirect.headers.set("location", "/");
  return redirect;
}

function decodeBotPathSegment(value: string): string {
  let botId: string;
  try {
    botId = decodeURIComponent(value);
  } catch {
    throw new ConfigurationDecodeError("invalid bot id");
  }
  try {
    return decodeBotIdV1(botId);
  } catch {
    throw new ConfigurationDecodeError("invalid bot id");
  }
}

const CATALOG_INDEX_PATH = "/catalog/v1/index";
const CATALOG_ENTRY_PREFIX = "/catalog/v1/entry/";

/**
 * A Catalog generation is immutable, so an explicitly pinned read can be cached
 * for as long as anything caches anything. The live read follows a pointer that
 * moves on every publish, so it is revalidated: the `etag` is the index's
 * content hash, which is exactly what a pinned reader compares.
 */
function catalogCacheControl(pinned: boolean): string {
  return pinned
    ? "private, max-age=31536000, immutable"
    : "private, max-age=60, must-revalidate";
}

function catalogDocumentResponse(
  request: Request,
  found: CatalogGatewayDocument,
  pinned: boolean,
): Response {
  const etag = `"${found.hash}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": catalogCacheControl(pinned),
    etag,
    "x-frockbot-catalog-generation": found.generation,
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(found.document, { headers });
}

/**
 * `GET /catalog/v1/index` and `GET /catalog/v1/entry/:id`, authenticated and
 * read-only. The browser and the Bot Durable Object both read the Catalog
 * through these, so the bucket stays behind the gateway and there is exactly
 * one place a Catalog document is verified before anyone sees it.
 */
async function routeCatalog(
  catalog: CatalogGatewayStore | undefined,
  request: Request,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method not allowed");
  }
  if (!catalog) {
    return jsonError(503, "Package Catalog is not configured");
  }
  const parameters = [...url.searchParams.keys()];
  if (
    parameters.some((key) => key !== "generation") ||
    url.searchParams.getAll("generation").length > 1
  ) {
    return jsonError(400, "catalog query is invalid");
  }
  const generation = url.searchParams.get("generation") ?? undefined;
  try {
    if (url.pathname === CATALOG_INDEX_PATH) {
      const found = await catalog.readIndexDocument(generation);
      if (!found) return jsonError(404, "catalog generation was not found");
      return catalogDocumentResponse(request, found, generation !== undefined);
    }
    let catalogId: string;
    try {
      catalogId = decodeURIComponent(
        url.pathname.slice(CATALOG_ENTRY_PREFIX.length),
      );
    } catch {
      return jsonError(400, "invalid catalog entry id");
    }
    const found = await catalog.readEntryDocument(catalogId, generation);
    if (!found) return jsonError(404, "catalog entry was not found");
    return catalogDocumentResponse(request, found, generation !== undefined);
  } catch (error) {
    // A generation that fails verification is a broken publish, and it is
    // reported as one rather than served with a caveat.
    return jsonError(
      502,
      error instanceof Error ? error.message : "catalog read failed",
    );
  }
}

interface DevelopmentIdentity {
  userId?: string;
  persist: boolean;
}

function developmentIdentity(request: Request): DevelopmentIdentity {
  const header = request.headers.get("x-frockbot-user-id")?.trim();
  if (header) return { userId: header, persist: false };

  try {
    const query = new URL(request.url).searchParams.get("as_user")?.trim();
    if (query) return { userId: query, persist: true };
  } catch {
    return { persist: false };
  }

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frockbot_dev_user="));
  return {
    userId: cookie?.slice("frockbot_dev_user=".length),
    persist: false,
  };
}

function allowedClientOrigin(
  request: Request,
  requestOrigin: string,
  allowedOrigins: string[] | undefined,
): string | null {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    (origin !== requestOrigin && !allowedOrigins?.includes(origin))
  ) {
    return null;
  }
  return origin;
}

/**
 * Whether `presented` is the anonymous artifact origin that serves this
 * gateway's Package pages: `ui.<host>` in a deployment, and `ui.localhost` for
 * a gateway on either spelling of the loopback in development.
 */
export function isPackageUiArtifactOriginFor(
  presented: string,
  gateway: URL,
): boolean {
  let origin: URL;
  try {
    origin = new URL(presented);
  } catch {
    return false;
  }
  if (origin.protocol !== gateway.protocol || origin.port !== gateway.port) {
    return false;
  }
  const loopback =
    gateway.hostname === "localhost" || gateway.hostname === "127.0.0.1";
  return loopback
    ? origin.hostname === "ui.localhost"
    : origin.hostname === `ui.${gateway.hostname}`;
}

function preflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      vary: "origin",
    },
  });
}

function withClientOrigin(response: Response, origin: string): Response {
  const shared = new Response(response.body, response);
  shared.headers.set("access-control-allow-origin", origin);
  shared.headers.set("access-control-expose-headers", "set-auth-token");
  shared.headers.append("vary", "origin");
  return shared;
}

const APPLET_SOCKET_PATH = /^\/api\/applets\/([^/]+)\/socket$/;

/**
 * `GET /api/applets/:appletId/socket?token=…`.
 *
 * Ahead of session authentication on purpose, and for the same reason the
 * machine door is: an Applet's page runs in a cookieless sandboxed iframe and
 * carries no session. The signed viewer token is the whole of the decision —
 * it names the User, the Applet, and the generation, it was minted by this
 * deployment, and it expires in fifteen minutes. A token that does not verify
 * never reaches a Durable Object, so an anonymous caller cannot create one.
 */
async function routeAppletSocket(
  request: Request,
  url: URL,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  if (!dependencies.appletViewerSecret || !dependencies.appletStateFor) {
    return jsonError(503, "Applet viewer sessions are not configured");
  }
  let appletId: string;
  try {
    appletId = decodeURIComponent(url.pathname.match(APPLET_SOCKET_PATH)![1]);
  } catch {
    return jsonError(400, "invalid applet id");
  }
  let claims;
  try {
    claims = await verifyAppletViewerTokenV1(
      dependencies.appletViewerSecret,
      url.searchParams.get("token"),
    );
  } catch (error) {
    return jsonError(
      error instanceof AppletViewerTokenError ? error.status : 401,
      "Applet viewer token is invalid",
    );
  }
  // The token is scoped to one Applet: a valid token for another Applet of the
  // same User is not a token for this one.
  if (claims.a !== appletId) {
    return jsonError(401, "Applet viewer token is invalid");
  }
  const forwarded = new URL(url);
  forwarded.searchParams.delete("token");
  forwarded.searchParams.set("u", claims.u);
  forwarded.searchParams.set("a", claims.a);
  forwarded.searchParams.set("g", claims.g);
  // `fetch`, not an RPC method: a 101 response with its WebSocket only
  // crosses the stub boundary on the object's HTTP door. The body goes with
  // it, so the outer drain must not reach for it afterwards.
  return dependencies
    .appletStateFor(claims.u, claims.a)
    .fetch(forwardingBodyV1(request, new Request(forwarded, request)));
}

const WORKSPACE_SEED_PATH = /^\/api\/workspace-seed\/([^/]+)\/([^/]+)$/;

/**
 * `PUT /api/workspace-seed/:userId/:botId`, bearer-authenticated by the seed
 * token, present only where `WORKSPACE_SEED_TOKEN` is set. See
 * `GatewayDependencies.workspaceSeed`.
 */
async function routeWorkspaceSeed(
  request: Request,
  url: URL,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const seed = dependencies.workspaceSeed;
  if (!seed) return jsonError(404, "not found");
  if (request.method !== "PUT") return jsonError(405, "method not allowed");
  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (presented.length === 0 || presented !== seed.token) {
    return jsonError(401, "seed token is invalid");
  }
  const match = url.pathname.match(WORKSPACE_SEED_PATH)!;
  let body: {
    root?: unknown;
    path?: unknown;
    bytesBase64?: unknown;
    mediaType?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError(400, "seed body is not JSON");
  }
  if (
    typeof body.path !== "string" ||
    typeof body.bytesBase64 !== "string" ||
    (body.mediaType !== undefined && typeof body.mediaType !== "string")
  ) {
    return jsonError(400, "seed body is invalid");
  }
  try {
    return Response.json(
      await seed.write(
        decodeURIComponent(match[1]!),
        decodeURIComponent(match[2]!),
        {
          root: body.root,
          path: body.path,
          bytesBase64: body.bytesBase64,
          ...(body.mediaType === undefined
            ? {}
            : { mediaType: body.mediaType }),
        },
      ),
    );
  } catch (error) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "seed write failed",
    );
  }
}

export function createGateway(dependencies: GatewayDependencies) {
  const compatibilityDate = dependencies.compatibilityDate ?? "2026-08-27";
  const debugRoute = createDebugRoute(dependencies.debug);

  const route = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname.startsWith("/api/auth/")) {
      return dependencies.auth.handler(request);
    }
    if (APPLET_SOCKET_PATH.test(url.pathname)) {
      return routeAppletSocket(request, url, dependencies);
    }
    if (WORKSPACE_SEED_PATH.test(url.pathname)) {
      return routeWorkspaceSeed(request, url, dependencies);
    }
    if (url.pathname === "/sign-out") {
      return routeSignOut(request, url, dependencies);
    }

    // Ahead of authentication: the operator surface is authorized by its own
    // token, and is readable when no session can be established at all.
    const debugResponse = await debugRoute(request, url);
    if (debugResponse) return debugResponse;

    for (const contribution of dependencies.backendContributions ?? []) {
      const response = await contribution.publicRoute?.(request, url, {
        client:
          request.headers.get("x-frockbot-client") === "desktop"
            ? "desktop"
            : "browser",
      });
      if (response) return response;
    }

    const development = dependencies.allowDevelopmentIdentity
      ? developmentIdentity(request)
      : { persist: false };
    const session = development.userId
      ? null
      : await dependencies.auth.getSession(request.headers);
    let userId = development.userId ?? session?.user.id;
    const authMode = development.userId
      ? "development"
      : session
        ? "better-auth"
        : "anonymous";
    const isPublicAsset =
      request.method === "GET" && PUBLIC_ASSET_PATHS.has(url.pathname);
    if (!userId && isPublicAsset) userId = PUBLIC_APPLICATION_USER_ID;
    if (!userId) return jsonError(401, "authentication required");
    const isAdmin =
      userId !== PUBLIC_APPLICATION_USER_ID &&
      isDeploymentAdminV1(
        {
          id: userId,
          ...(session?.user.email ? { email: session.user.email } : {}),
          mode: development.userId ? "development" : "better-auth",
        },
        dependencies.adminEmails,
      );
    if (
      userId !== PUBLIC_APPLICATION_USER_ID &&
      !development.userId &&
      !isAdmin
    ) {
      try {
        const exists = await dependencies.userExists(userId);
        if (!exists) {
          const policy = decodeDeploymentPolicyV1(
            await dependencies.readDeploymentPolicy(),
          );
          if (!policy.signups.open) {
            return signupClosedResponse(request, url);
          }
        }
      } catch (error) {
        return jsonError(
          503,
          error instanceof Error
            ? error.message
            : "Signup policy is unavailable",
        );
      }
    }
    if (request.method === "GET" && url.pathname === "/api/identity") {
      return Response.json({ schemaVersion: 1, userId, isAdmin });
    }

    const stateChannelMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/state-channel$/,
    );
    if (stateChannelMatch) {
      if (request.method !== "GET") {
        return jsonError(405, "method not allowed");
      }
      const encodedBotId = stateChannelMatch[1];
      if (!encodedBotId) return jsonError(400, "invalid Bot id");
      let botId: string;
      try {
        botId = decodeBotPathSegment(encodedBotId);
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "invalid Bot id",
        );
      }
      if (!dependencies.openBotStateChannel) {
        return jsonError(503, "Bot-state channel is unavailable");
      }
      try {
        return await dependencies.openBotStateChannel(userId, botId, request, {
          isAdmin,
          authMode,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error.name === "BotNotFoundError" ||
            error.name === "ComputerBotNotFoundError")
        ) {
          return jsonError(404, "Bot not found");
        }
        return jsonError(
          500,
          error instanceof Error ? error.message : "Bot-state channel failed",
        );
      }
    }

    if (
      url.pathname === CATALOG_INDEX_PATH ||
      url.pathname.startsWith(CATALOG_ENTRY_PREFIX)
    ) {
      return routeCatalog(dependencies.catalog, request, url);
    }

    for (const contribution of dependencies.backendContributions ?? []) {
      const response = await contribution.route(request, url, {
        userId,
        isAdmin,
        client:
          request.headers.get("x-frockbot-client") === "desktop"
            ? "desktop"
            : "browser",
      });
      if (response) return response;
    }

    const botSettingsMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/settings$/,
    );
    const isUserSettings = url.pathname === "/api/settings";
    if (isUserSettings || botSettingsMatch) {
      try {
        const pathBotId = botSettingsMatch
          ? decodeBotPathSegment(botSettingsMatch[1])
          : undefined;
        if (request.method === "GET") {
          if (!botSettingsMatch) {
            return Response.json(
              decodeUserSettingsViewV1(
                await dependencies
                  .userConfigurationFor(userId)
                  .readConfiguration({ schemaVersion: 1, userId }),
              ),
            );
          }
          const query = decodeConfigurationQueryV1({
            schemaVersion: 1,
            type: "bot/get",
            botId: pathBotId,
          });
          if (query.type !== "bot/get") {
            throw new ConfigurationDecodeError(
              "Bot settings require a Bot query",
            );
          }
          return Response.json(
            decodeBotSettingsViewV1(
              await dependencies
                .botConfigurationFor(userId, query.botId)
                .readConfiguration({
                  schemaVersion: 1,
                  userId,
                  botId: query.botId,
                }),
            ),
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const command = decodeConfigurationCommandV1(await request.json());
        if (
          botSettingsMatch &&
          "botId" in command &&
          command.botId !== pathBotId
        ) {
          return jsonError(400, "Bot command does not match the request path");
        }
        if (botSettingsMatch && !("botId" in command)) {
          return jsonError(400, "Bot settings require a Bot command");
        }
        if (isUserSettings && "botId" in command) {
          return jsonError(400, "User settings require a User command");
        }
        if (command.type === "user/set-platform-model") {
          return jsonError(
            403,
            "Platform model can only be set by a backend Contribution",
          );
        }
        if ("botId" in command) {
          return Response.json(
            decodeOperationReceiptV1(
              await dependencies
                .botConfigurationFor(userId, command.botId)
                .executeConfiguration({
                  schemaVersion: 1,
                  userId,
                  botId: command.botId,
                  command,
                }),
            ),
          );
        }
        return Response.json(
          decodeOperationReceiptV1(
            await dependencies
              .userConfigurationFor(userId)
              .executeConfiguration({
                schemaVersion: 1,
                userId,
                command,
              }),
          ),
        );
      } catch (error) {
        if (
          error instanceof ConfigurationDecodeError ||
          // The same refusal, raised inside the User Durable Object: only the
          // authority knows which settings the installed version of a Package
          // declares, so a value it refuses is still the client's bad request
          // and not a fault of ours. The class does not survive RPC; the name
          // does, exactly as `BotNotFoundError` below relies on.
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            error.name === "ConfigurationDecodeError")
        ) {
          return jsonError(
            400,
            error instanceof Error ? error.message : "configuration refused",
          );
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "BotNotFoundError"
        ) {
          return jsonError(
            404,
            error instanceof Error ? error.message : "Bot not found",
          );
        }
        if (
          error instanceof ConfigurationConflictError ||
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            error.name === "ConfigurationConflictError" &&
            "currentRevision" in error &&
            typeof error.currentRevision === "number")
        ) {
          const currentRevision =
            error instanceof ConfigurationConflictError
              ? error.currentRevision
              : error.currentRevision;
          return Response.json(
            {
              error: `configuration revision is ${currentRevision}`,
              code: "revision-conflict",
              currentRevision,
            },
            { status: 409 },
          );
        }
        return jsonError(
          500,
          error instanceof Error ? error.message : "Configuration failed",
        );
      }
    }

    let applicationHash: string;
    let workerId: string;
    try {
      applicationHash = await dependencies.applicationHashFor(userId);
      workerId = applicationDeploymentId({ userId, applicationHash });
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error ? error.message : "invalid deployment",
      );
    }

    const identity = { userId, applicationHash };
    const worker = dependencies.loader.get(workerId, async () => {
      const source = await dependencies.artifacts.load(applicationHash);
      const code: WorkerCode = {
        compatibilityDate,
        mainModule: "index.js",
        modules: { "index.js": { js: source } },
        env: {
          BOT_STATE: dependencies.botStateFor(userId),
          DEPLOYMENT: identity,
        },
        limits: { cpuMs: 30_000, subRequests: 1_000 },
      };
      return code;
    });

    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete("x-frockbot-user-id");
    forwardedHeaders.set("x-frockbot-deployment", workerId);
    forwardedHeaders.set("x-frockbot-auth-session-v1", authMode);
    forwardedHeaders.set("x-frockbot-is-admin-v1", String(isAdmin));
    const forwardedUrl = URL.parse(request.url);
    if (!forwardedUrl) return jsonError(400, "invalid request URL");
    if (development.persist) forwardedUrl.searchParams.delete("as_user");
    const forwardedRequest = new Request(request, {
      headers: forwardedHeaders,
    });
    // The loaded application is a separate isolate and this hands it the body.
    // Recorded before the await: once it has answered, the gateway's own
    // `request.body` is a stream the isolate will refuse to be touched.
    const response = await worker
      .getEntrypoint()
      .fetch(
        forwardingBodyV1(
          request,
          development.persist
            ? new Request(forwardedUrl, forwardedRequest)
            : forwardedRequest,
        ),
      );
    if (!development.persist) return response;
    const persisted = new Response(response.body, response);
    persisted.headers.append(
      "set-cookie",
      `frockbot_dev_user=${userId}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return persisted;
  };

  const handle = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonError(400, "invalid request URL");
    }

    if (dependencies.uiArtifactHosts?.includes(url.hostname)) {
      return servePackageUiArtifact(request, url, dependencies.artifacts);
    }

    const origin = allowedClientOrigin(
      request,
      url.origin,
      dependencies.allowedClientOrigins,
    );
    const isApiPath = url.pathname.startsWith("/api/");
    const presentedOrigin = request.headers.get("origin");
    // The Applet viewer socket is the one `/api/*` upgrade that does not come
    // from the app. Its page runs in a sandboxed iframe with no
    // `allow-same-origin`, so the browser sends the literal `Origin: null` — an
    // opaque origin — and a page on the artifact host itself would send
    // `ui.<this host>`. Either is admitted here and nothing else: the page is
    // cookieless, so this guard protects nothing on that path, and the signed
    // token in the URL is the whole of the decision (ADR 0022 §4).
    const appletSocketFromArtifactOrigin =
      APPLET_SOCKET_PATH.test(url.pathname) &&
      presentedOrigin !== null &&
      (presentedOrigin === "null" ||
        isPackageUiArtifactOriginFor(presentedOrigin, url));
    if (
      isApiPath &&
      presentedOrigin &&
      !origin &&
      !appletSocketFromArtifactOrigin &&
      (request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() === "websocket") &&
      request.method !== "HEAD"
    ) {
      return jsonError(403, "request origin is not allowed");
    }
    if (!origin || !isApiPath) return route(request, url);
    if (request.method === "OPTIONS") return preflightResponse(origin);
    // The 101 response carries the WebSocket endpoint and cannot be cloned as
    // an ordinary CORS response. Origin admission above is the browser guard.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return route(request, url);
    }
    return withClientOrigin(await route(request, url), origin);
  };

  /*
   * The gateway's error boundary.
   *
   * Every answer this Worker gives is JSON with a readable `error`, including
   * the ones nobody planned: an unavailable binding, an artifact that will not
   * load, a Contribution route that rejects. Without it workerd answers
   * `Internal Server Error` as plain text and the browser reports a JSON parse
   * failure, which tells the User nothing about what actually broke.
   */
  return async (request: Request): Promise<Response> => {
    let refusedForSize: Response | undefined;
    try {
      refusedForSize = turnBodyIsOversizedV1(request, new URL(request.url))
        ? jsonError(413, TURN_TOO_LONG_MESSAGE_V1)
        : undefined;
    } catch {
      // An unparseable URL is `handle`'s 400 to give, not this guard's.
    }
    if (refusedForSize) return drainedAnswerV1(request, refusedForSize);
    try {
      return await drainedAnswerV1(request, await handle(request));
    } catch (error) {
      return drainedAnswerV1(
        request,
        jsonError(
          500,
          error instanceof Error ? error.message : "gateway request failed",
        ),
      );
    }
  };
}
