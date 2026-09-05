import {
  ConfigurationDecodeError,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  isConnectionIdentifier,
  type ConnectionView,
  type StartConnectionCommandV1,
} from "@frockbot/configuration-core";
import {
  decodeStartConnectionResultV1,
  decodeRevokeConnectionResultV1,
  decodeAuthorizationState,
  encodeAuthorizationState,
  isStrongAuthorizationStateSecretV1,
  type AuthorizationState,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";
/**
 * The signed callback `state` moved to `@frockbot/connection-core` when a
 * second Package began minting one (`plugin-mcp`'s `mcp-oauth` driver). The
 * wire format is unchanged, so a state minted before the move still verifies,
 * and it is re-exported here because this Package's own surface promised it.
 */
export {
  decodeAuthorizationState,
  encodeAuthorizationState,
  type AuthorizationState,
} from "@frockbot/connection-core";
export type {
  ConnectionCompletionResult,
  RevokeConnectionResult,
  StartConnectionResult,
} from "./backend-contracts.js";
import {
  type ComposioConnectionCoordinator,
  DefinitiveConnectionOperationError,
  type ComposioConnectionStore,
  type ComposioConnectionTypeConfig,
} from "./connections.js";

function decodeConnectionIdentifier(value: unknown): string | undefined {
  return isConnectionIdentifier(value) ? value : undefined;
}

function decodeConnectionPathIdentifier(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return decodeConnectionIdentifier(decoded);
}

export interface BackendRouteContext {
  userId?: string;
  client: "browser" | "desktop";
}

export interface BackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: BackendRouteContext,
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: BackendRouteContext,
  ): Promise<Response | undefined>;
}

export interface ComposioBackendConfig {
  authorizationStateSecret: string;
  connectionsFor(
    userId: string,
  ): Pick<
    ComposioConnectionCoordinator,
    "replayStart" | "start" | "complete" | "fail" | "revoke"
  >;
  catalog?(userId: string): Promise<unknown>;
}

export interface ComposioBackendHost {
  readSecret?(name: string): string | undefined;
  composioRequest?(userId: string, input: unknown): Promise<unknown>;
}

export function createConfiguredComposioBackendContribution(
  host: ComposioBackendHost,
): BackendRouteContribution {
  const secret = host.readSecret?.("FROCKBOT_AUTHORIZATION_STATE_SECRET");
  if (!host.readSecret?.("COMPOSIO_API_KEY")?.trim())
    return {
      packageId: "composio",
      route: async (request, url, context) => {
        if (url.pathname !== "/api/plugins/composio/catalog") return undefined;
        if (!context.userId)
          return Response.json(
            { error: "authentication required" },
            { status: 401 },
          );
        if (request.method !== "GET")
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        return Response.json({ schemaVersion: 1, items: [] });
      },
    };
  if (
    !secret ||
    !isStrongAuthorizationStateSecretV1(secret) ||
    secret === host.readSecret?.("BETTER_AUTH_SECRET") ||
    !host.composioRequest
  ) {
    return {
      packageId: "composio",
      route: async (request, url, context) => {
        if (url.pathname !== "/api/plugins/composio/catalog") return undefined;
        if (!context.userId)
          return Response.json(
            { error: "authentication required" },
            { status: 401 },
          );
        if (request.method !== "GET")
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        return Response.json({ schemaVersion: 1, items: [] });
      },
    };
  }
  const request = host.composioRequest;
  return createComposioBackendContribution({
    authorizationStateSecret: secret,
    catalog: (userId) =>
      request(userId, { schemaVersion: 1, operation: "catalog" }),
    connectionsFor: (userId) => ({
      replayStart: async () => undefined,
      start: async (_user, input) =>
        decodeStartConnectionResultV1(
          await request(userId, {
            schemaVersion: 1,
            operation: "start",
            command: {
              schemaVersion: 1,
              type: "connection/start",
              commandId: input.commandId,
              connectionTypeId: input.connectionTypeId,
              ...(input.connectorId ? { connectorId: input.connectorId } : {}),
              ...(input.alias ? { alias: input.alias } : {}),
              ...(input.nativeReturnNonce
                ? { nativeReturnNonce: input.nativeReturnNonce }
                : {}),
            },
            start: {
              callbackState: input.callbackState,
              authorizationStateId: input.authorizationStateId,
              authorizationStateExpiresAt: input.authorizationStateExpiresAt,
              returnTarget: input.returnTarget,
            },
          }),
        ),
      complete: async (_user, input) =>
        decodeCompletion(
          await request(userId, {
            schemaVersion: 1,
            operation: "complete",
            ...input,
          }),
        ),
      fail: async (_user, connectionId, _failure, authorizationStateId) =>
        decodeCompletion(
          await request(userId, {
            schemaVersion: 1,
            operation: "fail",
            connectionId,
            authorizationStateId,
          }),
        ),
      revoke: async (_user, connectionId) =>
        decodeRevokeConnectionResultV1(
          await request(userId, {
            schemaVersion: 1,
            operation: "revoke",
            connectionId,
          }),
        ),
    }),
  });
}

function decodeCompletion(
  value: unknown,
): import("./backend-contracts.js").ConnectionCompletionResult {
  if (!value || typeof value !== "object")
    throw new Error("Connection result is invalid");
  const result = value as Record<string, unknown>;
  if (
    (result.returnTarget !== "browser" && result.returnTarget !== "desktop") ||
    (result.status !== "ready" &&
      result.status !== "pending" &&
      result.status !== "failed") ||
    (result.nativeReturnNonce !== undefined &&
      !isConnectionIdentifier(result.nativeReturnNonce))
  )
    throw new Error("Connection result is invalid");
  return {
    returnTarget: result.returnTarget,
    status: result.status,
    ...(typeof result.nativeReturnNonce === "string"
      ? { nativeReturnNonce: result.nativeReturnNonce }
      : {}),
  };
}

export namespace createConfiguredComposioBackendContribution {
  export function plugin(
    host: ComposioBackendHost,
    lifecycle: { mount(value: BackendRouteContribution): () => void },
  ): Plugin {
    return () =>
      lifecycle.mount(createConfiguredComposioBackendContribution(host));
  }
}

function jsonError(
  status: number,
  message: string,
  options?: { definitive?: boolean },
): Response {
  return Response.json({ error: message, ...options }, { status });
}

function requiredUser(context: BackendRouteContext): string | Response {
  return context.userId ?? jsonError(401, "authentication required");
}

/**
 * Answer a failed *browser* callback by returning the User to the app with the
 * reason attached, not with a JSON body rendered as a page.
 *
 * The callback is a top-level navigation, so `{"error":"..."}` is what the User
 * sees, on a URL with no way back into the app. A slow consent screen is enough
 * to land here — the authorization state is only valid for ten minutes.
 */
export function callbackFailureResponse(
  url: URL,
  message: string,
  target: "browser" | "desktop" = "browser",
): Response {
  if (target === "desktop") return jsonError(400, message);
  const destination = new URL("/", url.origin);
  destination.searchParams.set("connection", "composio-failed");
  destination.searchParams.set("connection_reason", message.slice(0, 300));
  return new Response(null, {
    status: 303,
    headers: { location: destination.toString() },
  });
}

export function connectionCompletionResponse(
  url: URL,
  target: "browser" | "desktop",
  status: "ready" | "pending" | "failed",
  nativeReturnNonce?: string,
): Response {
  const destination =
    target === "desktop"
      ? `com.frockbot.desktop:/connections?status=${status}${nativeReturnNonce ? `&nonce=${encodeURIComponent(nativeReturnNonce)}` : ""}`
      : new URL(`/?connection=composio-${status}`, url.origin).toString();
  return new Response(null, {
    status: 303,
    headers: { location: destination },
  });
}

export function createComposioBackendContribution(
  config: ComposioBackendConfig,
): BackendRouteContribution {
  const contribution: BackendRouteContribution = {
    packageId: "composio",
    async route(request, url, context) {
      if (url.pathname === "/api/plugins/composio/catalog" && config.catalog) {
        const user = requiredUser(context);
        if (user instanceof Response) return user;
        if (request.method !== "GET")
          return jsonError(405, "method not allowed");
        try {
          return Response.json(await config.catalog(user));
        } catch {
          return jsonError(
            503,
            "Could not load your connectors. Try again shortly.",
          );
        }
      }
      const isStart = url.pathname === "/api/plugins/composio/connections";
      const revokeMatch = url.pathname.match(
        /^\/api\/plugins\/composio\/connections\/([^/]+)\/revoke$/,
      );
      const isCallback = url.pathname === "/api/plugins/composio/callback";
      if (!isStart && !revokeMatch && !isCallback) return undefined;

      let revokeConnectionId: string | undefined;
      if (revokeMatch) {
        revokeConnectionId = decodeConnectionPathIdentifier(revokeMatch[1]);
        if (!revokeConnectionId) {
          return jsonError(400, "connectionId is invalid");
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
      }

      let callbackState: AuthorizationState | undefined;
      if (isCallback) {
        if (request.method !== "GET")
          return jsonError(405, "method not allowed");
        const encodedState = url.searchParams.get("state");
        if (!encodedState) {
          return callbackFailureResponse(
            url,
            "This connection link is missing its authorization state. Start the connection again.",
          );
        }
        try {
          callbackState = await decodeAuthorizationState(
            encodedState,
            config.authorizationStateSecret,
          );
        } catch (error) {
          return callbackFailureResponse(
            url,
            error instanceof Error
              ? error.message
              : "This connection link is no longer valid. Start the connection again.",
          );
        }
      }
      const user = callbackState?.userId ?? requiredUser(context);
      if (user instanceof Response) return user;

      if (isStart) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        let value: StartConnectionCommandV1;
        try {
          value = decodeStartConnectionCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error
              ? error.message
              : "Connection request is invalid",
          );
        }
        const { commandId, connectionTypeId } = value;
        if (
          (context.client === "desktop" && !value.nativeReturnNonce) ||
          (context.client === "browser" &&
            value.nativeReturnNonce !== undefined)
        ) {
          return jsonError(400, "nativeReturnNonce is invalid");
        }
        try {
          const nativeReturnNonce =
            context.client === "desktop" ? value.nativeReturnNonce : undefined;
          const startInput = {
            commandId,
            connectionTypeId,
            ...(value.connectorId ? { connectorId: value.connectorId } : {}),
            alias: value.alias,
            returnTarget: context.client,
            nativeReturnNonce,
          };
          const connections = config.connectionsFor(user);
          const replay = await connections.replayStart(user, startInput);
          if (replay) return Response.json(replay);
          const authorizationStateId = crypto.randomUUID();
          const authorizationStateExpiresAt = Date.now() + 10 * 60_000;
          const callbackState = await encodeAuthorizationState(
            {
              schemaVersion: 1,
              authorizationStateId,
              userId: user,
              connectionId: commandId,
              returnTarget: context.client,
              expiresAt: authorizationStateExpiresAt,
              nativeReturnNonce,
            },
            config.authorizationStateSecret,
          );
          return Response.json(
            await connections.start(user, {
              ...startInput,
              callbackState,
              authorizationStateId,
              authorizationStateExpiresAt,
              nativeReturnNonce,
            }),
            { status: 201 },
          );
        } catch (error) {
          if (error instanceof DefinitiveConnectionOperationError) {
            return jsonError(409, error.message, { definitive: true });
          }
          return jsonError(
            500,
            error instanceof Error ? error.message : "Connection failed",
          );
        }
      }

      if (revokeConnectionId) {
        try {
          decodeRevokeConnectionCommandV1(await request.json());
        } catch (error) {
          return jsonError(
            400,
            error instanceof ConfigurationDecodeError
              ? error.message
              : "Connection revoke command is invalid",
          );
        }
        try {
          const connections = config.connectionsFor(user);
          return Response.json(
            await connections.revoke(user, revokeConnectionId),
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
      const connections = config.connectionsFor(user);
      const connectionId = callbackState?.connectionId;
      const connectedAccountId =
        url.searchParams.get("connected_account_id") ??
        url.searchParams.get("connectedAccountId");
      if (connectionId && url.searchParams.get("status") === "failed") {
        try {
          const result = await connections.fail(
            user,
            connectionId,
            "Authorization was not completed",
            callbackState!.authorizationStateId,
          );
          return connectionCompletionResponse(
            url,
            result.returnTarget,
            result.status,
            result.nativeReturnNonce,
          );
        } catch (error) {
          return callbackFailureResponse(
            url,
            error instanceof Error ? error.message : "Connection failed",
            callbackState?.returnTarget === "desktop" ? "desktop" : "browser",
          );
        }
      }
      if (!connectionId || !connectedAccountId) {
        return callbackFailureResponse(
          url,
          "The provider did not return a connected account. Start the connection again.",
          callbackState?.returnTarget === "desktop" ? "desktop" : "browser",
        );
      }
      try {
        const result = await connections.complete(user, {
          connectionId,
          connectedAccountId,
          authorizationStateId: callbackState!.authorizationStateId,
        });
        return connectionCompletionResponse(
          url,
          result.returnTarget,
          result.status,
          result.nativeReturnNonce,
        );
      } catch (error) {
        return callbackFailureResponse(
          url,
          error instanceof Error ? error.message : "Connection failed",
          callbackState?.returnTarget === "desktop" ? "desktop" : "browser",
        );
      }
    },
  };
  contribution.publicRoute = (request, url, context) =>
    url.pathname === "/api/plugins/composio/callback"
      ? contribution.route(request, url, context)
      : Promise.resolve(undefined);
  return contribution;
}

export type { ComposioConnectionStore, ConnectionView };

export const backendContribution = defineGatewayContribution<
  ComposioBackendHost,
  BackendRouteContribution
>({
  specifier: "@frockbot/plugin-composio/backend",
  create: (host, lifecycle) =>
    createConfiguredComposioBackendContribution.plugin(host, lifecycle),
});
