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
import type {
  GatewayDependencies,
  UserApplicationIdentity,
  WorkerCode,
} from "./contracts.js";

const PUBLIC_APPLICATION_USER_ID = "anonymous";
const PUBLIC_ASSET_PATHS = new Set(["/", "/app.js", "/app.css"]);

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
  shared.headers.set("access-control-expose-headers", "set-auth-token");
  shared.headers.append("vary", "origin");
  return shared;
}

export function createGateway(dependencies: GatewayDependencies) {
  const compatibilityDate = dependencies.compatibilityDate ?? "2026-08-27";

  const route = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname.startsWith("/api/auth/")) {
      return dependencies.auth.handler(request);
    }

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
    if (request.method === "GET" && url.pathname === "/api/identity") {
      return Response.json({ schemaVersion: 1, userId });
    }

    for (const contribution of dependencies.backendContributions ?? []) {
      const response = await contribution.route(request, url, {
        userId,
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
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, error.message);
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
    const forwardedUrl = URL.parse(request.url);
    if (!forwardedUrl) return jsonError(400, "invalid request URL");
    if (development.persist) forwardedUrl.searchParams.delete("as_user");
    const forwardedRequest = new Request(request, {
      headers: forwardedHeaders,
    });
    const response = await worker
      .getEntrypoint()
      .fetch(
        development.persist
          ? new Request(forwardedUrl, forwardedRequest)
          : forwardedRequest,
      );
    if (!development.persist) return response;
    const persisted = new Response(response.body, response);
    persisted.headers.append(
      "set-cookie",
      `frockbot_dev_user=${userId}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return persisted;
  };

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonError(400, "invalid request URL");
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
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      return jsonError(403, "request origin is not allowed");
    }
    if (!origin || !isApiPath) return route(request, url);
    if (request.method === "OPTIONS") return preflightResponse(origin);
    return withClientOrigin(await route(request, url), origin);
  };
}
