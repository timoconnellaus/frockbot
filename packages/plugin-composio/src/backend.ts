import type { ConnectionView } from "@frockbot/configuration-core";
import type { ComposioClient } from "./composio-client.js";
import {
  ComposioConnectionCoordinator,
  type ComposioConnectionStore,
  type ComposioConnectionTypeConfig,
} from "./connections.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface BackendRouteContext {
  userId?: string;
  client: "browser" | "desktop";
}

export interface BackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: BackendRouteContext,
  ): Promise<Response | undefined>;
}

export interface ComposioBackendConfig {
  client: ComposioClient;
  callbackBaseUrl: string;
  connectionTypes: Record<string, ComposioConnectionTypeConfig>;
  storeFor(userId: string): ComposioConnectionStore;
  assignBot?: (
    userId: string,
    botId: string,
    connectionId: string,
    leaseId: string,
  ) => Promise<void>;
  markBotUnavailable?: (
    userId: string,
    botId: string,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ) => Promise<"applied" | "stale">;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function requiredUser(context: BackendRouteContext): string | Response {
  return context.userId ?? jsonError(401, "authentication required");
}

function coordinator(
  config: ComposioBackendConfig,
  userId: string,
): ComposioConnectionCoordinator {
  return new ComposioConnectionCoordinator({
    client: config.client,
    store: config.storeFor(userId),
    callbackBaseUrl: config.callbackBaseUrl,
    connectionTypes: config.connectionTypes,
    assignBot: config.assignBot,
    markBotUnavailable: config.markBotUnavailable,
  });
}

export function connectionCompletionResponse(
  url: URL,
  target: "browser" | "desktop",
  status: "ready" | "failed",
): Response {
  const destination =
    target === "desktop"
      ? new URL(`com.frockbot.desktop:/connections?status=${status}`)
      : new URL(`/?connection=composio-${status}`, url.origin);
  return new Response(null, {
    status: 303,
    headers: { location: destination.toString() },
  });
}

export function createComposioBackendContribution(
  config: ComposioBackendConfig,
): BackendRouteContribution {
  return {
    packageId: "composio",
    async route(request, url, context) {
      const isStart = url.pathname === "/api/plugins/composio/connections";
      const revokeMatch = url.pathname.match(
        /^\/api\/plugins\/composio\/connections\/([^/]+)\/revoke$/,
      );
      const isCallback = url.pathname === "/api/plugins/composio/callback";
      if (!isStart && !revokeMatch && !isCallback) return undefined;

      const user = requiredUser(context);
      if (user instanceof Response) return user;
      const connections = coordinator(config, user);

      if (isStart) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        try {
          const input: unknown = await request.json();
          if (typeof input !== "object" || input === null) {
            return jsonError(400, "Connection request must be an object");
          }
          const value = input as Record<string, unknown>;
          if (
            typeof value.commandId !== "string" ||
            !ID_PATTERN.test(value.commandId)
          ) {
            return jsonError(400, "commandId is invalid");
          }
          if (typeof value.connectionTypeId !== "string") {
            return jsonError(400, "connectionTypeId is required");
          }
          if (
            typeof value.botId !== "string" ||
            !ID_PATTERN.test(value.botId)
          ) {
            return jsonError(400, "botId is invalid");
          }
          if (
            value.alias !== undefined &&
            (typeof value.alias !== "string" || value.alias.trim().length > 100)
          ) {
            return jsonError(400, "alias is invalid");
          }
          return Response.json(
            await connections.start(user, {
              commandId: value.commandId,
              connectionTypeId: value.connectionTypeId,
              botId: value.botId,
              alias: value.alias as string | undefined,
              returnTarget: context.client,
            }),
            { status: 201 },
          );
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "Connection failed",
          );
        }
      }

      if (revokeMatch) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        try {
          return Response.json(
            await connections.revoke(user, decodeURIComponent(revokeMatch[1])),
          );
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "Revocation failed",
          );
        }
      }

      if (request.method !== "GET") {
        return jsonError(405, "method not allowed");
      }
      const connectionId = url.searchParams.get("connection");
      const connectedAccountId =
        url.searchParams.get("connected_account_id") ??
        url.searchParams.get("connectedAccountId");
      if (connectionId && url.searchParams.get("status") === "failed") {
        try {
          const result = await connections.fail(
            user,
            connectionId,
            "Composio authorization was not completed",
          );
          return connectionCompletionResponse(
            url,
            result.returnTarget,
            "failed",
          );
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "Connection failed",
          );
        }
      }
      if (!connectionId || !connectedAccountId) {
        return jsonError(400, "Composio callback is incomplete");
      }
      try {
        const result = await connections.complete(user, {
          connectionId,
          connectedAccountId,
        });
        return connectionCompletionResponse(url, result.returnTarget, "ready");
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Connection failed",
        );
      }
    },
  };
}

export type { ComposioConnectionStore, ConnectionView };
