import { decodeProtocol } from "@frockbot/core/protocol-schemas";
import { settingsDocumentV1 } from "@frockbot/app/settings/document";
import { connectionsCatalogQueryV1 } from "@frockbot/app/settings/frame";
import { secretsDocumentV1 } from "@frockbot/app/secrets/document";
import {
  botPluginsDocumentV1,
  decodeBotPluginsCommandV1,
} from "@frockbot/app/plugins/page";
import { decodePanelFocusCommandV1 } from "@frockbot/app/plugins/panels";
import { decodeDeviceUseCommandV1 } from "@frockbot/app/audit";
import { decodePluginPageReportCommandV1 } from "@frockbot/app/plugins/page-reports";
import { accessEmailV1 } from "@frockbot/app/admin/shared";
import {
  ACCOUNT_DELETION_PATH_V1,
  COMPUTER_DELETION_PATH_V1,
  accountDeletionConfirmationV1,
  accountDeletionConfirmedV1,
  decodeAccountDeletionCommandV1,
  decodeComputerDeletionCommandV1,
} from "@frockbot/app/account/deletion";
import {
  admissionRefusedResponse,
  admissionUnavailableResponse,
} from "./account-admission.js";
import { isNativeAuthPath, readNativeJsonBody } from "./native-auth.js";
import { clientCompatibilityResponse } from "./client-compatibility.js";
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
} from "@frockbot/core/configuration";
import { DEPLOYMENT_HEADER_V1 } from "@frockbot/core/protocol";
import {
  DEVELOPMENT_USER_ID,
  isDeploymentAdminV1,
} from "./admin-identities.js";
import type {
  GatewayDependencies,
  UserApplicationIdentity,
  WorkerCode,
} from "./contracts.js";
import {
  VOICE_ASSISTANT_PATH_V1,
  VOICE_CAPABILITIES_PATH_V1,
  VOICE_DICTATION_PATH_V1,
  type VoiceCapabilitiesV1,
} from "@frockbot/app/voice/shared";
import {
  whatsNewFeedV1,
  whatsNewImageNameV1,
  whatsNewPublishedAtV1,
} from "@frockbot/app/whats-new";
import {
  voiceAssistantEdgeTimingV1,
  type VoiceTimingV1,
} from "@frockbot/app/voice/diagnostics";
import { createDebugRoute } from "./debug.js";
import { isPluginPagePathV1, servePluginPageV1 } from "./plugin-page-route.js";
import {
  drainedAnswerV1,
  forwardingBodyV1,
  TURN_TOO_LONG_MESSAGE_V1,
  turnBodyIsOversizedV1,
} from "./request-body.js";

const PUBLIC_APPLICATION_USER_ID = "anonymous";
/**
 * What an unauthenticated GET may reach: the document, the site icon, and
 * What’s New stills. The stills are product copy, not a secret, and Flutter
 * loads them with a plain GET that carries no cookie on the web.
 *
 * The client's own payload is not here. It is the Worker's static assets,
 * content-addressed under `/_flutter/<buildHash>/` and answered by the asset
 * router before this Worker runs, so nothing about it is per-account and no
 * request for it arrives at this function.
 */
export function isPublicAssetPathV1(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/favicon.ico" ||
    whatsNewImageNameV1(pathname) !== undefined
  );
}

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
  // The Android shell runs the same client from a `capacitor://` origin, so
  // the header that names the application has to be exposed or the WebView
  // cannot read it and the app would never notice a release.
  shared.headers.set(
    "access-control-expose-headers",
    `set-auth-token, ${DEPLOYMENT_HEADER_V1}`,
  );
  shared.headers.append("vary", "origin");
  return shared;
}

/**
 * The one door into a User's loaded application.
 *
 * Both a signed-in browser request and the owner-only debug send use this
 * helper. Keeping the latter on this path means its command is decoded by the
 * same application artifact and admitted by the same User/Bot Durable Object
 * bindings as a message from the composer.
 */
async function routeUserApplication(
  dependencies: GatewayDependencies,
  compatibilityDate: string,
  request: Request,
  userId: string,
  authMode: string,
  isAdmin: boolean,
  persistDevelopmentIdentity: boolean,
): Promise<Response> {
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
  if (persistDevelopmentIdentity) {
    forwardedUrl.searchParams.delete("as_user");
  }
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
        persistDevelopmentIdentity
          ? new Request(forwardedUrl, forwardedRequest)
          : forwardedRequest,
      ),
    );
  const named = deploymentAnsweredV1(response, applicationHash);
  if (!persistDevelopmentIdentity) return named;
  const persisted = new Response(named.body, named);
  persisted.headers.append(
    "set-cookie",
    `frockbot_dev_user=${userId}; Path=/; HttpOnly; SameSite=Strict`,
  );
  return persisted;
}

/**
 * Names the application an answer came from.
 *
 * A tab left open across a release keeps running the client bundle it was
 * served, and that bundle is baked into the application artifact — so the
 * hash of the artifact that answered is exactly "the client you should be
 * running". It is already resolved on this path, so saying it costs nothing.
 *
 * A WebSocket upgrade is handed back untouched: it carries no headers worth
 * rewriting, and copying one throws.
 */
export function deploymentAnsweredV1(
  response: Response,
  applicationHash: string,
): Response {
  if (response.status === 101 || response.webSocket) return response;
  const named = new Response(response.body, response);
  named.headers.set(DEPLOYMENT_HEADER_V1, applicationHash);
  return named;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function isAccountDeleted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AccountDeletedError"
  );
}

/**
 * Deleting the account, and deleting the Computer.
 *
 * The account is deleted only against the phrase the person typed, checked
 * here against the identity this request authenticated as — never one the
 * body names. It answers 202 once the deletion is durably under way; the
 * rest happens without them. An account whose deletion already began, or
 * ended, answers as deleted, so a retried press is not an error.
 */
async function deletionRoute(
  dependencies: GatewayDependencies,
  request: Request,
  url: URL,
  identity: { userId: string; email: string | undefined },
): Promise<Response> {
  const deletion = dependencies.deletion;
  if (!deletion) return jsonError(503, "Deleting is unavailable");
  const confirmation = accountDeletionConfirmationV1({
    userId: identity.userId,
    ...(identity.email ? { email: identity.email } : {}),
  });
  if (url.pathname === ACCOUNT_DELETION_PATH_V1 && request.method === "GET") {
    return Response.json(
      { schemaVersion: 1, confirmation },
      { headers: NO_STORE },
    );
  }
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  let body: unknown;
  try {
    body = await readNativeJsonBody(request);
  } catch {
    return jsonError(400, "invalid request");
  }
  try {
    if (url.pathname === COMPUTER_DELETION_PATH_V1) {
      let command;
      try {
        command = decodeComputerDeletionCommandV1(body);
      } catch {
        return jsonError(400, "invalid request");
      }
      return Response.json(
        await deletion.deleteComputer(identity.userId, command.commandId),
        { headers: NO_STORE },
      );
    }
    let command;
    try {
      command = decodeAccountDeletionCommandV1(body);
    } catch {
      return jsonError(400, "invalid request");
    }
    if (!accountDeletionConfirmedV1(confirmation, command.confirmation)) {
      return Response.json(
        {
          error: `Type ${confirmation} to confirm.`,
          code: "confirmation-mismatch",
        },
        { status: 409, headers: NO_STORE },
      );
    }
    const email = accessEmailV1(identity.email);
    return Response.json(
      await deletion.deleteAccount(identity.userId, {
        commandId: command.commandId,
        ...(email === undefined ? {} : { email }),
      }),
      { status: 202, headers: NO_STORE },
    );
  } catch (error) {
    if (isAccountDeleted(error)) {
      return url.pathname === ACCOUNT_DELETION_PATH_V1
        ? Response.json(
            { schemaVersion: 1, status: "deleting" },
            { status: 202, headers: NO_STORE },
          )
        : jsonError(410, "This account is being deleted.");
    }
    return jsonError(
      502,
      error instanceof Error && error.message
        ? error.message
        : "Deleting failed. Try again.",
    );
  }
}

/**
 * Who a request is, and whether they may come in: a native bearer, the
 * development identity, or the browser's session, then the admission
 * authority. A refusal is the answer to send instead.
 */
async function identifyRequest(
  dependencies: GatewayDependencies,
  request: Request,
  url: URL,
) {
  let development = dependencies.allowDevelopmentIdentity
    ? developmentIdentity(request)
    : { persist: false };
  const nativeIdentity = await dependencies.nativeAuth?.authenticate(request);
  const nativeRefusal = nativeIdentity?.refusal;
  if (nativeRefusal) return { refusal: nativeRefusal };
  // The app signed in through the development door: the same identity the
  // browser's "Continue as local developer" carries, with the same standing.
  if (
    dependencies.allowDevelopmentIdentity &&
    nativeIdentity?.session?.user.id === DEVELOPMENT_USER_ID
  ) {
    development = { userId: DEVELOPMENT_USER_ID, persist: false };
  }
  const session = nativeIdentity
    ? nativeIdentity.session
    : development.userId
      ? null
      : await dependencies.auth.getSession(request.headers);
  let userId = development.userId ?? session?.user.id;
  const authMode: "development" | "better-auth" | "anonymous" =
    development.userId ? "development" : session ? "better-auth" : "anonymous";
  const isPublicAsset =
    request.method === "GET" && isPublicAssetPathV1(url.pathname);
  if (!userId && isPublicAsset) userId = PUBLIC_APPLICATION_USER_ID;
  if (!userId) return { refusal: jsonError(401, "authentication required") };
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
  // Every authenticated request asks, so pausing an account takes effect on
  // its next request rather than at its next sign-in. An admin is never
  // asked: the allowlist admits them even while the authority is down.
  if (
    userId !== PUBLIC_APPLICATION_USER_ID &&
    !development.userId &&
    !isAdmin
  ) {
    // A native bearer was already admitted by `nativeAuth`, which had to
    // ask after verifying its existing session without provisioning a User.
    let admission = nativeIdentity?.admission;
    if (!admission) {
      const email = accessEmailV1(session?.user.email);
      try {
        admission = await dependencies.admitAccount({
          schemaVersion: 1,
          userId,
          ...(email === undefined ? {} : { email }),
          emailVerified: session?.user.emailVerified === true,
          isAdmin,
        });
      } catch {
        return { refusal: admissionUnavailableResponse() };
      }
    }
    if (!admission.admitted) {
      return {
        refusal: admissionRefusedResponse(
          admission.reason,
          request.method === "GET" && url.pathname === "/",
        ),
      };
    }
  }
  return { userId, session, development, authMode, isAdmin };
}

export function createGateway(
  dependencies: GatewayDependencies,
  entryTiming?: VoiceTimingV1,
) {
  const compatibilityDate = dependencies.compatibilityDate ?? "2026-08-27";
  const debugRoute = createDebugRoute(
    dependencies.debug,
    async (userId, botId, text) => {
      const url = new URL(
        `/api/bots/${encodeURIComponent(botId)}/turns`,
        "https://frockbot.internal",
      );
      const request = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: crypto.randomUUID(),
          text,
        }),
      });
      return routeUserApplication(
        dependencies,
        compatibilityDate,
        request,
        userId,
        "better-auth",
        true,
        false,
      );
    },
  );

  const route = async (request: Request, url: URL): Promise<Response> => {
    const incompatible = clientCompatibilityResponse(request, url);
    if (incompatible) return incompatible;
    const nativeResponse = await dependencies.nativeAuth?.route(request);
    if (nativeResponse) return nativeResponse;
    // A disabled or misconfigured native door never falls through to Better
    // Auth or the authenticated application. Browser/Capacitor routes keep
    // their existing path, including unrelated well-known endpoints.
    if (isNativeAuthPath(url.pathname)) {
      return Response.json(
        { error: "Native sign-in is unavailable. Please try again later." },
        {
          status: 503,
          headers: { "cache-control": "no-store" },
        },
      );
    }
    if (url.pathname.startsWith("/api/auth/")) {
      return dependencies.auth.handler(request);
    }
    if (url.pathname === "/sign-out") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return dependencies.auth.signOut(request, url);
    }

    // Ahead of authentication: the operator surface is authorized by its own
    // token, and is readable when no session can be established at all.
    const debugResponse = await debugRoute(request, url);
    if (debugResponse) return debugResponse;

    // Resolved once, when first asked: a public route that must act only for
    // the browser's own session asks, and everything after the public routes
    // needs it.
    let identified: ReturnType<typeof identifyRequest> | undefined;
    const identify = () =>
      (identified ??= identifyRequest(dependencies, request, url));

    for (const contribution of dependencies.backendContributions ?? []) {
      const response = await contribution.publicRoute?.(request, url, {
        client:
          request.headers.get("x-frockbot-client") === "desktop"
            ? "desktop"
            : "browser",
        sessionUserId: async () => {
          const identity = await identify();
          return identity.refusal ||
            identity.userId === PUBLIC_APPLICATION_USER_ID
            ? undefined
            : identity.userId;
        },
      });
      if (response) return response;
    }

    // Opt-in voice diagnostics, and only for the assistant upgrade: the
    // object's own first line is written after everything here has already
    // happened, so authentication is invisible from inside it.
    const timing = entryTiming ?? voiceAssistantEdgeTimingV1(url);
    timing?.mark("edge-auth-start");
    const identity = await identify();
    if (identity.refusal) return identity.refusal;
    const { userId, session, development, authMode, isAdmin } = identity;
    // Authenticated and admitted: everything above is what a socket waits
    // through before a route is even chosen.
    timing?.mark("edge-auth-ready");
    if (request.method === "GET" && url.pathname === "/api/identity") {
      return Response.json({ schemaVersion: 1, userId, isAdmin });
    }
    if (url.pathname === "/api/whats-new") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return Response.json(whatsNewFeedV1(whatsNewPublishedAtV1), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/push/device") {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      if (!dependencies.registerPush)
        return jsonError(503, "Push is unavailable");
      try {
        const registration = await readNativeJsonBody(request);
        return Response.json(
          await dependencies.registerPush(userId, registration),
        );
      } catch {
        return jsonError(400, "Push registration failed");
      }
    }

    if (
      url.pathname === ACCOUNT_DELETION_PATH_V1 ||
      url.pathname === COMPUTER_DELETION_PATH_V1
    ) {
      if (userId === PUBLIC_APPLICATION_USER_ID)
        return jsonError(401, "authentication required");
      return deletionRoute(dependencies, request, url, {
        userId,
        email: session?.user.email,
      });
    }

    if (url.pathname === VOICE_CAPABILITIES_PATH_V1) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      const capabilities = dependencies.voice?.capabilities() ?? {
        dictation: false,
        assistant: false,
      };
      return Response.json(
        { schemaVersion: 1, ...capabilities } satisfies VoiceCapabilitiesV1,
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      url.pathname === VOICE_DICTATION_PATH_V1 ||
      url.pathname === VOICE_ASSISTANT_PATH_V1
    ) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonError(426, "expected a WebSocket upgrade");
      }
      if (userId === PUBLIC_APPLICATION_USER_ID) {
        return jsonError(401, "authentication required");
      }
      if (!dependencies.voice) return jsonError(503, "Voice is unavailable");
      try {
        if (url.pathname === VOICE_DICTATION_PATH_V1) {
          return await dependencies.voice.openDictation(userId, request);
        }
        const deviceKey = (url.searchParams.get("device") ?? "").slice(0, 64);
        timing?.mark("edge-assistant-forward");
        const upgraded = await dependencies.voice.openAssistant(
          userId,
          /^[A-Za-z0-9._-]{1,64}$/.test(deviceKey) ? deviceKey : "unknown",
          request,
          { isAdmin, authMode },
        );
        timing?.mark("edge-assistant-upgraded", { status: upgraded.status });
        return upgraded;
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "Voice failed to open",
        );
      }
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

    if (url.pathname === "/api/settings/models/options") {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      let query;
      try {
        query = decodeProtocol(
          "SettingsOptionsQuery",
          await readNativeJsonBody(request),
        );
      } catch {
        return jsonError(400, "Invalid model search");
      }
      try {
        return Response.json(
          decodeProtocol(
            "SettingsOptionsPage",
            await dependencies
              .userConfigurationFor(userId)
              .readSettingsOptions({ schemaVersion: 1, userId, query }),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ConfigurationConflictError"
        )
          return jsonError(409, "Models changed. Refresh and try again.");
        return jsonError(503, "Models are temporarily unavailable.");
      }
    }

    if (url.pathname === "/api/settings/connections") {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      let catalog;
      try {
        catalog = connectionsCatalogQueryV1(url.searchParams);
      } catch {
        return jsonError(400, "Invalid Marketplace search");
      }
      try {
        const frame = decodeProtocol(
          "ConnectionsFrame",
          await dependencies.userConfigurationFor(userId).readConnectionsFrame({
            schemaVersion: 1,
            userId,
            ...(catalog ? { catalog } : {}),
          }),
        );
        return Response.json(frame, {
          headers: { "cache-control": "no-store" },
        });
      } catch {
        return jsonError(503, "Connections are temporarily unavailable.");
      }
    }

    // The User's saved secrets, for Settings: what each is called and where
    // it may be used, and a delete. Nothing here reads or answers a value.
    const deleteSecretMatch = url.pathname.match(
      /^\/api\/secrets\/(secret-[0-9a-f]{32})\/delete$/,
    );
    if (url.pathname === "/api/secrets" || deleteSecretMatch) {
      const owner = dependencies.userConfigurationFor(userId);
      try {
        if (deleteSecretMatch) {
          if (request.method !== "POST") {
            return jsonError(405, "method not allowed");
          }
          return Response.json(
            await owner.deleteSecret({
              schemaVersion: 1,
              userId,
              secretId: deleteSecretMatch[1]!,
            }),
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        const list = await owner.listSecrets({ schemaVersion: 1, userId });
        return Response.json(
          url.searchParams.get("as") === "document"
            ? secretsDocumentV1(list)
            : list,
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return jsonError(503, "Saved secrets are temporarily unavailable.");
      }
    }

    if (
      ["/api/settings/application", "/api/settings/models"].includes(
        url.pathname,
      )
    ) {
      const home = url.pathname.endsWith("/models") ? "models" : "application";
      try {
        const owner = dependencies.userConfigurationFor(userId);
        if (request.method === "GET") {
          // Identity supplies only an unsaved profile suggestion. The User's
          // saved profile wins and only a save command persists edited fields.
          const identity =
            home !== "application"
              ? null
              : development.userId
                ? { name: "Local developer" }
                : await dependencies.auth.profile?.(userId).catch(() => null);
          const frame = decodeProtocol(
            "SettingsFrame",
            await owner.readSettingsFrame({
              schemaVersion: 1,
              userId,
              home,
              ...(identity?.name?.trim()
                ? { identityName: identity.name.trim().slice(0, 100) }
                : {}),
              ...(identity?.email?.trim()
                ? { identityEmail: identity.email.trim().slice(0, 320) }
                : {}),
              ...(identity &&
              "image" in identity &&
              typeof identity.image === "string" &&
              identity.image.startsWith("https://")
                ? { identityImage: identity.image.slice(0, 2048) }
                : {}),
            }),
          );
          // The frame is what this route produces; `as=document` asks for the
          // same settings in the vocabulary the host renders every plugin
          // view in. Nothing else about the route changes, so the client that
          // wants a frame keeps getting one.
          return Response.json(
            url.searchParams.get("as") === "document"
              ? settingsDocumentV1(
                  home === "application"
                    ? {
                        ...frame,
                        sections: frame.sections.filter(
                          (section) =>
                            section.id ===
                            (url.searchParams.get("section") ?? "profile"),
                        ),
                      }
                    : frame,
                )
              : frame,
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (request.method !== "POST")
          return jsonError(405, "method not allowed");
        let command;
        try {
          command = decodeProtocol(
            "SettingsChangeCommand",
            await readNativeJsonBody(request, 512_000),
          );
        } catch {
          return jsonError(400, "Invalid settings command");
        }
        if (command.ownerId !== userId)
          return jsonError(403, "Settings belong to another account.");
        return Response.json(
          decodeOperationReceiptV1(
            await owner.changeSettings({
              schemaVersion: 1,
              userId,
              home,
              command,
            }),
          ),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ConfigurationConflictError"
        )
          return jsonError(409, "Settings changed. Refresh and try again.");
        if (error instanceof Error && error.name === "ConfigurationDecodeError")
          return jsonError(400, "Check these settings and try again.");
        return jsonError(503, "Settings are temporarily unavailable.");
      }
    }

    const botPluginsMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/plugins$/,
    );
    if (botPluginsMatch) {
      try {
        const botId = decodeBotPathSegment(botPluginsMatch[1]);
        const binding = dependencies.botConfigurationFor(userId, botId);
        if (request.method === "GET") {
          const frame = await binding.readBotPluginsFrame({
            schemaVersion: 1,
            userId,
            botId,
          });
          return Response.json(
            url.searchParams.get("as") === "document"
              ? botPluginsDocumentV1(frame)
              : frame,
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        // The command's own decode is the only failure that is the caller's
        // fault; everything past it is ours, and echoing its message would
        // report a storage failure as a bad request.
        let command;
        try {
          command = decodeBotPluginsCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "invalid plugin command",
          );
        }
        return Response.json(
          command.kind === "plugin-tool"
            ? await binding.executeBotPluginTool({
                schemaVersion: 1,
                userId,
                botId,
                command,
              })
            : await binding.setBotPluginEnabled({
                schemaVersion: 1,
                userId,
                botId,
                command,
              }),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, "invalid bot id");
        }
        return jsonError(503, "Plugins are temporarily unavailable.");
      }
    }

    const botPanelsOpenMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/panels\/open$/,
    );
    if (botPanelsOpenMatch) {
      try {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        const botId = decodeBotPathSegment(botPanelsOpenMatch[1]);
        return Response.json(
          await dependencies
            .botConfigurationFor(userId, botId)
            .openFocusedPanel({
              schemaVersion: 1,
              userId,
              botId,
              appOrigin: url.origin,
            }),
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, "invalid bot id");
        }
        return jsonError(503, "Panels are temporarily unavailable.");
      }
    }

    const botPanelsFocusMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/panels\/focus$/,
    );
    if (botPanelsFocusMatch) {
      try {
        const botId = decodeBotPathSegment(botPanelsFocusMatch[1]);
        const binding = dependencies.botConfigurationFor(userId, botId);
        if (request.method === "GET") {
          const opened = await binding.openFocusedPanel({
            schemaVersion: 1,
            userId,
            botId,
            appOrigin: url.origin,
          });
          return Response.json(
            {
              schemaVersion: 1,
              pluginId: opened.focus.pluginId,
              ...(opened.focus.surfaceId
                ? { surfaceId: opened.focus.surfaceId }
                : {}),
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        let command;
        try {
          command = decodePanelFocusCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "invalid panel focus",
          );
        }
        const result = await binding.setFocusedPanel({
          schemaVersion: 1,
          userId,
          botId,
          pluginId: command.pluginId,
          ...(command.surfaceId ? { surfaceId: command.surfaceId } : {}),
        });
        if (result.status === "error") {
          return jsonError(400, result.failure);
        }
        return Response.json(result.focus, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, "invalid bot id");
        }
        return jsonError(503, "Panels are temporarily unavailable.");
      }
    }

    const botPanelsDeviceUseMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/panels\/device-use$/,
    );
    if (botPanelsDeviceUseMatch) {
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      try {
        const botId = decodeBotPathSegment(botPanelsDeviceUseMatch[1]);
        let use;
        try {
          use = decodeDeviceUseCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "invalid device use",
          );
        }
        const result = await dependencies
          .botConfigurationFor(userId, botId)
          .recordPanelDeviceUse({ schemaVersion: 1, userId, botId, use });
        if (result.status === "refused") {
          return jsonError(400, result.reason);
        }
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, "invalid bot id");
        }
        return jsonError(503, "Panels are temporarily unavailable.");
      }
    }

    const botPanelsPageReportMatch = url.pathname.match(
      /^\/api\/bots\/([^/]+)\/panels\/page-report$/,
    );
    if (botPanelsPageReportMatch) {
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      try {
        const botId = decodeBotPathSegment(botPanelsPageReportMatch[1]);
        let report;
        try {
          report = decodePluginPageReportCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "invalid page report",
          );
        }
        const result = await dependencies
          .botConfigurationFor(userId, botId)
          .recordPanelPageReport({ schemaVersion: 1, userId, botId, report });
        if (result.status === "refused") {
          return jsonError(400, result.reason);
        }
        return Response.json(result, {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, "invalid bot id");
        }
        return jsonError(503, "Panels are temporarily unavailable.");
      }
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
            if (
              url.searchParams.has("view") &&
              url.searchParams.get("view") !== "2"
            )
              return jsonError(426, "Refresh FrockBot to update Settings.");
            return Response.json(
              settingsProjection(
                await dependencies
                  .userConfigurationFor(userId)
                  .readConfiguration({
                    schemaVersion: 1,
                    userId,
                    view: url.searchParams.get("view") === "2" ? 2 : 1,
                  }),
                url.searchParams.get("view"),
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
        if (
          command.type === "user/set-package-settings" &&
          command.packageId === "custom-models" &&
          (Object.hasOwn(command.values ?? {}, "account-model") ||
            command.unset?.includes("account-model"))
        ) {
          return jsonError(426, "Refresh FrockBot to update Models.");
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

    return routeUserApplication(
      dependencies,
      compatibilityDate,
      request,
      userId,
      authMode,
      isAdmin,
      development.persist,
    );
  };

  const handle = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonError(400, "invalid request URL");
    }

    // Anonymous and ahead of everything: a Plugin page is fetched by a
    // credentialless frame, and its own CSP is its whole posture.
    if (isPluginPagePathV1(url.pathname)) {
      return servePluginPageV1(
        request,
        url,
        dependencies.artifacts.loadPluginPage?.bind(dependencies.artifacts),
      );
    }

    const origin = allowedClientOrigin(
      request,
      url.origin,
      dependencies.allowedClientOrigins,
    );
    const isApiPath = url.pathname.startsWith("/api/");
    const presentedOrigin = request.headers.get("origin");
    if (
      isApiPath &&
      presentedOrigin &&
      !origin &&
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

/** The previous browser wire shape remains readable while Models moves to frames. */
function settingsProjection(input: unknown, contract: string | null) {
  const decoded = decodeUserSettingsViewV1(input);
  if (contract === "2") return decoded;
  const { accountModel: _accountModel, ...view } = decoded;
  return view;
}
