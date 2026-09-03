/**
 * The MCP gateway Contribution: the status projection and the lifecycle
 * commands, on routes this Package owns.
 *
 * The Settings Package already carries `/api/connections`, and an MCP server
 * is a Connection, so rename and remove need nothing here. What does need a
 * route is everything the provider-neutral Connection command union has no
 * word for — a server's durable state, its instructions, and its restart —
 * and the honest place for it is `plugin-mcp`, not a Settings Package that
 * would then have to know what MCP is.
 *
 * The gateway dispatches every mounted Contribution in turn and takes the
 * first non-`undefined` Response, so this is purely additive: no route, host,
 * or decoder in `plugin-settings` changes.
 */
import {
  decodeAuthorizationState,
  encodeAuthorizationState,
  isStrongAuthorizationStateSecretV1,
  type AuthorizationState,
  type ConnectionCompletionResult,
  type RevokeConnectionResult,
  type StartConnectionResult,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";
import {
  decodeMcpLifecycleReceiptV1,
  decodeMcpServerStatusViewV1,
  type McpLifecycleReceiptV1,
  type McpServerStatusViewV1,
} from "./records.js";
import { MCP_PACKAGE_ID } from "./agent.js";
import { mcpAuthorizationConnectionIdV1 } from "./oauth-records.js";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";

export const MCP_SERVERS_ROUTE = "/api/mcp/servers";
export const MCP_CONNECTIONS_ROUTE = "/api/plugins/mcp/connections";
export const MCP_CALLBACK_ROUTE = "/api/plugins/mcp/callback";
const MCP_REVOKE_PATTERN =
  /^\/api\/plugins\/mcp\/connections\/([^/]+)\/revoke$/;

/** How long a minted authorization state is good for. */
const AUTHORIZATION_STATE_TTL_MS = 10 * 60_000;

/**
 * The body `POST /api/plugins/mcp/connections` accepts.
 *
 * Deliberately not `StartConnectionCommandV1`: that command is the
 * provider-neutral one, and it has no word for the server URL a User is
 * naming or the Connection they are reconnecting. Decoding MCP's own shape
 * here keeps `configuration-core` from growing an MCP-shaped field.
 */
export interface McpStartAuthorizationCommandV1 {
  schemaVersion: 1;
  type: "connection/start";
  commandId: string;
  connectionTypeId: string;
  /** Reconnecting an existing Connection; absent creates one. */
  connectionId?: string;
  label?: string;
  settings?: Record<string, unknown>;
  nativeReturnNonce?: string;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`MCP authorization ${label} is invalid`);
  }
  return value;
}

export function decodeMcpStartAuthorizationCommandV1(
  input: unknown,
): McpStartAuthorizationCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("MCP authorization command is invalid");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "type",
    "commandId",
    "connectionTypeId",
    "connectionId",
    "label",
    "settings",
    "nativeReturnNonce",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`MCP authorization command carries unknown "${key}"`);
    }
  }
  if (value.schemaVersion !== 1 || value.type !== "connection/start") {
    throw new Error("MCP authorization command is unsupported");
  }
  if (
    value.settings !== undefined &&
    (!value.settings ||
      typeof value.settings !== "object" ||
      Array.isArray(value.settings))
  ) {
    throw new Error("MCP authorization settings are invalid");
  }
  if (
    value.label !== undefined &&
    (typeof value.label !== "string" ||
      value.label.length === 0 ||
      value.label.length > 120)
  ) {
    throw new Error("MCP authorization label is invalid");
  }
  return {
    schemaVersion: 1,
    type: "connection/start",
    commandId: identifier(value.commandId, "commandId"),
    connectionTypeId: identifier(value.connectionTypeId, "connectionTypeId"),
    ...(value.connectionId === undefined
      ? {}
      : { connectionId: identifier(value.connectionId, "connectionId") }),
    ...(value.label === undefined ? {} : { label: value.label as string }),
    ...(value.settings === undefined
      ? {}
      : { settings: value.settings as Record<string, unknown> }),
    ...(value.nativeReturnNonce === undefined
      ? {}
      : {
          nativeReturnNonce: identifier(
            value.nativeReturnNonce,
            "nativeReturnNonce",
          ),
        }),
  };
}

/**
 * Where the User's browser is sent once the callback has been handled.
 *
 * Byte-for-byte the shape `plugin-composio` uses, because it is the shape the
 * clients already read: a browser lands back on `/?connection=mcp-<status>`,
 * and a desktop shell on its own deep link carrying the nonce it minted.
 */
export function mcpConnectionCompletionResponse(
  url: URL,
  target: "browser" | "desktop",
  status: "ready" | "pending" | "failed",
  nativeReturnNonce?: string,
): Response {
  const destination =
    target === "desktop"
      ? `com.frockbot.desktop:/connections?status=${status}${
          nativeReturnNonce
            ? `&nonce=${encodeURIComponent(nativeReturnNonce)}`
            : ""
        }`
      : new URL(`/?connection=mcp-${status}`, url.origin).toString();
  return new Response(null, {
    status: 303,
    headers: { location: destination },
  });
}

export interface McpGatewayHost {
  readMcpServers(userId: string): Promise<McpServerStatusViewV1>;
  executeMcpCommand(
    userId: string,
    command: unknown,
  ): Promise<McpLifecycleReceiptV1>;
  /**
   * The `mcp-oauth` seams, absent on a deployment that configures no
   * authorization-state secret. All three land in the User Durable Object: this
   * Contribution signs a state and forwards, and performs no OAuth call.
   */
  startMcpAuthorization?(
    userId: string,
    input: McpAuthorizationStartRequestV1,
  ): Promise<StartConnectionResult>;
  completeMcpAuthorization?(
    userId: string,
    input: McpAuthorizationCompletionRequestV1,
  ): Promise<ConnectionCompletionResult>;
  revokeMcpAuthorization?(
    userId: string,
    connectionId: string,
  ): Promise<RevokeConnectionResult>;
  /** Reads a deployment secret. Only `FROCKBOT_AUTHORIZATION_STATE_SECRET` is read. */
  readSecret?(name: string): string | undefined;
  /**
   * The absolute origin the callback is reachable at, when the deployment
   * pins one. Absent takes the origin the request arrived on, which is what a
   * development host and a preview deployment both need.
   */
  callbackBaseUrl?: string;
}

export interface McpAuthorizationStartRequestV1 {
  commandId: string;
  connectionId?: string;
  label?: string;
  settings?: Record<string, unknown>;
  redirectUri: string;
  callbackState: string;
  authorizationStateId: string;
  authorizationStateExpiresAt: number;
  returnTarget: "browser" | "desktop";
  nativeReturnNonce?: string;
}

export interface McpAuthorizationCompletionRequestV1 {
  authorizationStateId: string;
  connectionId: string;
  returnTarget: "browser" | "desktop";
  nativeReturnNonce?: string;
  code?: string;
  error?: string;
}

export interface McpBackendRouteContribution {
  packageId: string;
  /**
   * The OAuth callback, which runs *before* the gateway has authenticated
   * anyone. It has to: an authorization server redirects the User's browser
   * here with no FrockBot session attached. The identity it acts as comes from
   * the HMAC-signed `state` and from nowhere else — `context.userId` is not
   * consulted on this path, and no query parameter is trusted for identity.
   */
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client?: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * The signing secret, or `undefined` when this deployment has none.
 *
 * The same two checks `plugin-composio` makes, for the same reason: this
 * secret is the only thing standing between a forged query string and acting
 * as another User, so a weak one is refused at construction rather than
 * trusted at callback time, and it may not be the session secret — one
 * compromise must not become two.
 */
function authorizationStateSecret(host: McpGatewayHost): string | undefined {
  const secret = host.readSecret?.("FROCKBOT_AUTHORIZATION_STATE_SECRET");
  if (
    !secret ||
    !isStrongAuthorizationStateSecretV1(secret) ||
    secret === host.readSecret?.("BETTER_AUTH_SECRET")
  ) {
    return undefined;
  }
  return secret;
}

export function createMcpBackendContribution(
  host: McpGatewayHost,
): McpBackendRouteContribution {
  const secret = authorizationStateSecret(host);
  const authorizationConfigured =
    secret !== undefined &&
    host.startMcpAuthorization !== undefined &&
    host.completeMcpAuthorization !== undefined &&
    host.revokeMcpAuthorization !== undefined;

  const callbackUrl = (url: URL): string =>
    new URL(MCP_CALLBACK_ROUTE, host.callbackBaseUrl ?? url.origin).toString();

  const routeAuthorization = async (
    request: Request,
    url: URL,
    context: { userId?: string; client?: "browser" | "desktop" },
  ): Promise<Response | undefined> => {
    const isStart = url.pathname === MCP_CONNECTIONS_ROUTE;
    const revokeMatch = url.pathname.match(MCP_REVOKE_PATTERN);
    const isCallback = url.pathname === MCP_CALLBACK_ROUTE;
    if (!isStart && !revokeMatch && !isCallback) return undefined;
    if (!authorizationConfigured || !secret) {
      return jsonError(503, "MCP authorization is not configured");
    }
    const client = context.client === "desktop" ? "desktop" : "browser";

    if (isCallback) {
      if (request.method !== "GET") {
        return jsonError(405, "method not allowed");
      }
      // Identity, and only identity, comes from here. The `code`, the
      // `connectionId`, the `state` — everything else on this URL was chosen
      // by whoever sent the browser, and the signature is what says which
      // User's Durable Object may be opened at all.
      const encodedState = url.searchParams.get("state");
      if (!encodedState) {
        return jsonError(400, "MCP callback state is required");
      }
      let state: AuthorizationState;
      try {
        state = await decodeAuthorizationState(encodedState, secret);
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "MCP callback is invalid",
        );
      }
      const code = url.searchParams.get("code") ?? undefined;
      const failure = url.searchParams.get("error") ?? undefined;
      try {
        const result = await host.completeMcpAuthorization!(state.userId, {
          authorizationStateId: state.authorizationStateId,
          connectionId: state.connectionId,
          returnTarget: state.returnTarget,
          ...(state.nativeReturnNonce
            ? { nativeReturnNonce: state.nativeReturnNonce }
            : {}),
          ...(code ? { code } : {}),
          ...(failure ? { error: failure } : {}),
        });
        return mcpConnectionCompletionResponse(
          url,
          result.returnTarget,
          result.status,
          result.nativeReturnNonce,
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "MCP authorization failed",
        );
      }
    }

    if (!context.userId) return jsonError(401, "authentication required");
    if (request.method !== "POST") {
      return jsonError(405, "method not allowed");
    }

    if (revokeMatch) {
      let connectionId: string;
      try {
        connectionId = identifier(
          decodeURIComponent(revokeMatch[1]!),
          "connectionId",
        );
      } catch {
        return jsonError(400, "connectionId is invalid");
      }
      try {
        return Response.json(
          await host.revokeMcpAuthorization!(context.userId, connectionId),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "MCP revocation failed",
        );
      }
    }

    let command: McpStartAuthorizationCommandV1;
    try {
      command = decodeMcpStartAuthorizationCommandV1(await request.json());
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error
          ? error.message
          : "MCP authorization command is invalid",
      );
    }
    if (
      (client === "desktop" && !command.nativeReturnNonce) ||
      (client === "browser" && command.nativeReturnNonce !== undefined)
    ) {
      return jsonError(400, "nativeReturnNonce is invalid");
    }
    const authorizationStateId = crypto.randomUUID();
    const authorizationStateExpiresAt = Date.now() + AUTHORIZATION_STATE_TTL_MS;
    try {
      // The state is signed here, before the User Durable Object is asked for
      // anything: it binds this callback to this User, this Connection and one
      // single-use id, and the gateway keeps no copy of it.
      const callbackState = await encodeAuthorizationState(
        {
          schemaVersion: 1,
          authorizationStateId,
          userId: context.userId,
          connectionId:
            command.connectionId ??
            mcpAuthorizationConnectionIdV1(command.commandId),
          returnTarget: client,
          expiresAt: authorizationStateExpiresAt,
          ...(command.nativeReturnNonce
            ? { nativeReturnNonce: command.nativeReturnNonce }
            : {}),
        },
        secret,
      );
      const started = await host.startMcpAuthorization!(context.userId, {
        commandId: command.commandId,
        ...(command.connectionId ? { connectionId: command.connectionId } : {}),
        ...(command.label ? { label: command.label } : {}),
        ...(command.settings ? { settings: command.settings } : {}),
        redirectUri: callbackUrl(url),
        callbackState,
        authorizationStateId,
        authorizationStateExpiresAt,
        returnTarget: client,
        ...(command.nativeReturnNonce
          ? { nativeReturnNonce: command.nativeReturnNonce }
          : {}),
      });
      return Response.json(started, { status: 201 });
    } catch (error) {
      return jsonError(
        400,
        error instanceof Error ? error.message : "MCP authorization failed",
      );
    }
  };

  const contribution: McpBackendRouteContribution = {
    packageId: MCP_PACKAGE_ID,
    async route(request, url, context) {
      const authorization = await routeAuthorization(request, url, context);
      if (authorization) return authorization;
      if (!context.userId) return undefined;
      if (url.pathname !== MCP_SERVERS_ROUTE) return undefined;
      if (request.method === "GET") {
        try {
          return Response.json(
            decodeMcpServerStatusViewV1(
              await host.readMcpServers(context.userId),
            ),
          );
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error ? error.message : "MCP status read failed",
          );
        }
      }
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      try {
        // Decoded on the far side of the seam, in the Durable Object that
        // owns the records; the receipt is decoded again on the way back so
        // the client never sees a shape this build did not produce.
        return Response.json(
          decodeMcpLifecycleReceiptV1(
            await host.executeMcpCommand(context.userId, await request.json()),
          ),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error
            ? error.message
            : "MCP lifecycle command failed",
        );
      }
    },
  };
  // The callback, and nothing else, is public. It runs before authentication
  // because it has to; every other route on this Contribution still requires a
  // session.
  contribution.publicRoute = (request, url, context) =>
    url.pathname === MCP_CALLBACK_ROUTE
      ? contribution.route(request, url, context)
      : Promise.resolve(undefined);
  return contribution;
}

export namespace createMcpBackendContribution {
  export function plugin(
    host: McpGatewayHost,
    lifecycle: { mount(value: McpBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createMcpBackendContribution(host));
  }
}

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  McpGatewayHost,
  McpBackendRouteContribution
>({
  specifier: "@frockbot/plugin-mcp/backend",
  create: createMcpBackendContribution.plugin,
});
