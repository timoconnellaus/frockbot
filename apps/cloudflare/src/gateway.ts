import {
  ConfigurationConflictError,
  ConfigurationDecodeError,
  decodeConfigurationCommandV1,
  type ConfigurationQueryV1,
} from "@frockbot/configuration-core";
import type {
  GatewayDependencies,
  UserApplicationIdentity,
  WorkerCode,
} from "./contracts.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const PUBLIC_APPLICATION_USER_ID = "anonymous";
const PUBLIC_ASSET_PATHS = new Set(["/", "/app.js", "/app.css"]);

export function applicationDeploymentId(
  identity: UserApplicationIdentity,
): string {
  if (!ID_PATTERN.test(identity.userId)) {
    throw new Error("invalid user id");
  }
  if (!HASH_PATTERN.test(identity.applicationHash)) {
    throw new Error("invalid application hash");
  }
  return `${identity.userId}:${identity.applicationHash}`;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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
  allowedOrigins: string[] | undefined,
): string | null {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins?.includes(origin)) return null;
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

    const development = dependencies.allowDevelopmentIdentity
      ? developmentIdentity(request)
      : { persist: false };
    const session = development.userId
      ? null
      : await dependencies.auth.getSession(request.headers);
    let userId = development.userId ?? session?.user.id;
    const isPublicAsset =
      request.method === "GET" && PUBLIC_ASSET_PATHS.has(url.pathname);
    if (!userId && isPublicAsset) userId = PUBLIC_APPLICATION_USER_ID;
    if (!userId) return jsonError(401, "authentication required");

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
      const configuration = dependencies.configurationFor(userId);
      try {
        if (request.method === "GET") {
          let query: ConfigurationQueryV1 = {
            schemaVersion: 1,
            type: "user/get",
          };
          if (botSettingsMatch) {
            const botId = decodeURIComponent(botSettingsMatch[1]);
            query = { schemaVersion: 1, type: "bot/get", botId };
          }
          return Response.json(await configuration.read(query));
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const command = decodeConfigurationCommandV1(await request.json());
        if (
          botSettingsMatch &&
          "botId" in command &&
          command.botId !== decodeURIComponent(botSettingsMatch[1])
        ) {
          return jsonError(400, "Bot command does not match the request path");
        }
        if (botSettingsMatch && !("botId" in command)) {
          return jsonError(400, "Bot settings require a Bot command");
        }
        if (isUserSettings && "botId" in command) {
          return jsonError(400, "User settings require a User command");
        }
        return Response.json(await configuration.execute(command));
      } catch (error) {
        if (error instanceof ConfigurationDecodeError) {
          return jsonError(400, error.message);
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
        globalOutbound: null,
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
    const response = await worker
      .getEntrypoint()
      .fetch(new Request(request, { headers: forwardedHeaders }));
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
      dependencies.allowedClientOrigins,
    );
    const isApiPath = url.pathname.startsWith("/api/");
    if (!origin || !isApiPath) return route(request, url);
    if (request.method === "OPTIONS") return preflightResponse(origin);
    return withClientOrigin(await route(request, url), origin);
  };
}
