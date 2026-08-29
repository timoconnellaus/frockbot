import {
  ConfigurationDecodeError,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  type ConnectionView,
  type StartConnectionCommandV1,
} from "@frockbot/configuration-core";
import { ComposioClient } from "./composio-client.js";
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

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_CONNECTION_IDENTIFIERS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function decodeConnectionIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value) ||
    RESERVED_CONNECTION_IDENTIFIERS.has(value)
  ) {
    return undefined;
  }
  return value;
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
  markBotUnavailable?: (
    userId: string,
    botId: string,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ) => Promise<"applied" | "stale">;
}

export interface ComposioBackendHost {
  callbackBaseUrl: string;
  readSecret(name: string): string | undefined;
  storeFor(userId: string): ComposioConnectionStore;
  markConnectionUnavailable(
    userId: string,
    botId: string,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale">;
}

export function createConfiguredComposioBackendContribution(
  host: ComposioBackendHost,
): BackendRouteContribution {
  const apiKey = host.readSecret("COMPOSIO_API_KEY");
  const gmailAuthConfigId = host.readSecret("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
  const authorizationStateSecret = host.readSecret(
    "FROCKBOT_AUTHORIZATION_STATE_SECRET",
  );
  if (!apiKey || !gmailAuthConfigId || !authorizationStateSecret) {
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
    markBotUnavailable: host.markConnectionUnavailable,
  });
}

export interface AuthorizationState {
  schemaVersion: 1;
  authorizationStateId: string;
  userId: string;
  connectionId: string;
  returnTarget: "browser" | "desktop";
  expiresAt: number;
  nativeReturnNonce?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function stateKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function encodeAuthorizationState(
  state: AuthorizationState,
  secret: string,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(state));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await stateKey(secret), payload),
  );
  return `${base64Url(payload)}.${base64Url(signature)}`;
}

export async function decodeAuthorizationState(
  value: string,
  secret: string,
): Promise<AuthorizationState> {
  const [payloadPart, signaturePart, extra] = value.split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) {
    throw new Error("Composio authorization state is invalid");
  }
  const payload = fromBase64Url(payloadPart);
  const signature = fromBase64Url(signaturePart);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await stateKey(secret),
      new Uint8Array(signature).buffer,
      new Uint8Array(payload).buffer,
    ))
  ) {
    throw new Error("Composio authorization state is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("Composio authorization state is invalid");
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Composio authorization state is invalid");
  }
  const state = decoded as Partial<AuthorizationState>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.authorizationStateId !== "string" ||
    !ID_PATTERN.test(state.authorizationStateId) ||
    typeof state.userId !== "string" ||
    !ID_PATTERN.test(state.userId) ||
    typeof state.connectionId !== "string" ||
    !ID_PATTERN.test(state.connectionId) ||
    (state.returnTarget !== "browser" && state.returnTarget !== "desktop") ||
    !Number.isSafeInteger(state.expiresAt) ||
    (state.expiresAt as number) <= Date.now() ||
    (state.nativeReturnNonce !== undefined &&
      (typeof state.nativeReturnNonce !== "string" ||
        !ID_PATTERN.test(state.nativeReturnNonce)))
  ) {
    throw new Error("Composio authorization state is invalid or expired");
  }
  return state as AuthorizationState;
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
    markBotUnavailable: config.markBotUnavailable,
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
