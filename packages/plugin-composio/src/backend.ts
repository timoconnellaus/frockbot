import {
  ConfigurationDecodeError,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  isConnectionIdentifier,
  type ConnectionView,
  type StartConnectionCommandV1,
} from "@frockbot/configuration-core";
import {
  decodeAuthorizationState,
  encodeAuthorizationState,
  isStrongAuthorizationStateSecretV1,
  type AuthorizationState,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";
import { ComposioClient } from "./composio-client.js";
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
  ComposioConnectionCoordinator,
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
  client: ComposioClient;
  callbackBaseUrl: string;
  connectionTypes: Record<string, ComposioConnectionTypeConfig>;
  authorizationStateSecret: string;
  storeFor(userId: string): ComposioConnectionStore;
}

export interface ComposioBackendHost {
  callbackBaseUrl: string;
  readSecret(name: string): string | undefined;
  storeFor(userId: string): ComposioConnectionStore;
}

export function createConfiguredComposioBackendContribution(
  host: ComposioBackendHost,
): BackendRouteContribution {
  const apiKey = host.readSecret("COMPOSIO_API_KEY");
  const gmailAuthConfigId = host.readSecret("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
  const authorizationStateSecret = host.readSecret(
    "FROCKBOT_AUTHORIZATION_STATE_SECRET",
  );
  const betterAuthSecret = host.readSecret("BETTER_AUTH_SECRET");
  if (
    !apiKey ||
    !gmailAuthConfigId ||
    !authorizationStateSecret ||
    !isStrongAuthorizationStateSecretV1(authorizationStateSecret) ||
    authorizationStateSecret === betterAuthSecret
  ) {
    throw new Error("Composio backend Contribution is not configured");
  }
  return createComposioBackendContribution({
    client: new ComposioClient({ apiKey }),
    storeFor: host.storeFor,
    callbackBaseUrl: host.callbackBaseUrl,
    authorizationStateSecret,
    connectionTypes: {
      gmail: {
        authConfigId: gmailAuthConfigId,
        displayName: "Gmail",
        toolkitSlug: "gmail",
      },
    },
  });
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

function coordinator(
  config: ComposioBackendConfig,
  userId: string,
): ComposioConnectionCoordinator {
  return new ComposioConnectionCoordinator({
    client: config.client,
    store: config.storeFor(userId),
    callbackBaseUrl: config.callbackBaseUrl,
    connectionTypes: config.connectionTypes,
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
        const encodedState = url.searchParams.get("state");
        if (!encodedState)
          return jsonError(400, "Composio callback state is required");
        try {
          callbackState = await decodeAuthorizationState(
            encodedState,
            config.authorizationStateSecret,
          );
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error ? error.message : "Connection failed",
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
        if (!Object.hasOwn(config.connectionTypes, connectionTypeId)) {
          return jsonError(400, "connectionTypeId is invalid");
        }
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
            alias: value.alias,
            returnTarget: context.client,
            nativeReturnNonce,
          };
          const connections = coordinator(config, user);
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
          const connections = coordinator(config, user);
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
      const connections = coordinator(config, user);
      const connectionId = callbackState?.connectionId;
      const connectedAccountId =
        url.searchParams.get("connected_account_id") ??
        url.searchParams.get("connectedAccountId");
      if (connectionId && url.searchParams.get("status") === "failed") {
        try {
          const result = await connections.fail(
            user,
            connectionId,
            "Composio authorization was not completed",
            callbackState!.authorizationStateId,
          );
          return connectionCompletionResponse(
            url,
            result.returnTarget,
            result.status,
            result.nativeReturnNonce,
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
          authorizationStateId: callbackState!.authorizationStateId,
        });
        return connectionCompletionResponse(
          url,
          result.returnTarget,
          result.status,
          result.nativeReturnNonce,
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Connection failed",
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
