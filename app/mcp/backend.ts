// The gateway's MCP server routes: signing in to a server, the Disconnect an
// installed app presses, the page an authorization server sends the person
// back to, the door an app finishes a sign-in through, and FrockBot's client
// metadata document.
//
//   POST /api/plugins/mcp/connections/:connectionId/authorize   start a sign-in
//   POST /api/plugins/mcp/connections/:connectionId/revoke      remove a server
//   GET  /api/mcp/oauth/callback[/<return client>]              the return page
//   POST /api/mcp/oauth/complete                                an app finishes
//   GET  /api/mcp/oauth/client                                  client metadata
//
// The callback is public: an authorization server redirects a browser, and
// whoever holds a sign-in link can be the one it redirects. So the signed
// state only says which User started the sign-in; the code is traded only for
// a request that is that User. A browser tab proves it with its own session,
// checked here against the state. An app's browser has no session: its page
// hands the answer to the app, which sends it back with its own bearer to
// `complete`, checked the same way. Either way the state is verified before
// any Durable Object is addressed — an anonymous request must not choose
// which object is woken — and the User object then holds the attempt the
// state names and trades its code once.
import {
  decodeConnectionCommandReceiptV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/core/connection";
import {
  decodeStartConnectionCommandV1,
  type ConnectionReturnClientV1,
} from "@frockbot/core/configuration";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import { returnPageV1 } from "@frockbot/app/return-page";
import { connectCallbackPathV1 } from "@frockbot/app/connect/user";
import { MCP_CONNECTION_TYPE_ID, MCP_PACKAGE_ID } from "./definition.js";
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CLIENT_PATH,
  MCP_OAUTH_COMPLETE_PATH,
  MCP_RETURN_PARAMETERS_V1,
  mcpOAuthCallbackPathV1,
  mcpOAuthClientMetadataV1,
  mcpOAuthReturnClientV1,
  mcpReturnHandOffV1,
} from "./oauth.js";
import { verifyMcpOAuthStateV1, type McpOAuthStateV1 } from "./oauth-state.js";

export interface McpGatewayHost {
  executeConnection(
    userId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1>;
  /**
   * The credential keyring a sign-in's state is verified under. Absent, the
   * callback refuses every state and nothing is signed in to.
   */
  mcpSignInKeyring?: string;
  now?: () => number;
}

export interface McpBackendRouteContribution {
  packageId: string;
  publicRoute(
    request: Request,
    url: URL,
    context?: { sessionUserId?: () => Promise<string | undefined> },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
}

const CONNECTION_ROUTE = new RegExp(
  `^/api/plugins/${MCP_PACKAGE_ID}/connections/([^/]+)/(authorize|revoke)$`,
);
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

const EXPIRED_LINE =
  "This sign-in link has expired or isn't one FrockBot made.";
const FAILED_LINE = "The sign-in couldn't finish. Sign in again.";
const ELSEWHERE_LINE =
  "This sign-in was started from another FrockBot account, so nothing was connected.";
/** Longer than any code, state or error a server sends back. */
const MAX_RETURN_FIELD = 4_096;

/** What a browser tab is told once the server's sign-in is done. */
function signedInPage(
  origin: string,
  outcome: { ok: true } | { ok: false; line: string },
): Response {
  return outcome.ok
    ? returnPageV1({
        title: "Signed in",
        heading: "Signed in",
        lead: "Your Bots can use this server's tools now. You can close this tab and return to FrockBot.",
        action: { label: "Open FrockBot", href: `${origin}/` },
        footnote:
          "You can remove the server, or sign in again, from Connectors.",
      })
    : returnPageV1({
        title: "Sign-in didn't finish",
        heading: "Sign-in didn't finish",
        lead: outcome.line,
        action: { label: "Open FrockBot", href: `${origin}/` },
        footnote: "Sign in again from Connectors in FrockBot.",
      });
}

/**
 * A browser that is not the User who started the sign-in: signed out, or
 * signed in as someone else. Nothing was traded, and it says so.
 */
function elsewherePage(origin: string): Response {
  return returnPageV1({
    title: "Finish in FrockBot",
    heading: "Finish signing in from FrockBot",
    lead: "This browser isn't signed in to the FrockBot account that started this sign-in, so nothing was connected. Open FrockBot where you're signed in, and sign in to the server again from Connectors.",
    action: { label: "Open FrockBot", href: `${origin}/` },
    footnote:
      "If you didn't start this sign-in, close this tab. Nothing was connected.",
  });
}

/**
 * An app's page: the Connect return page for that app — the one an installed
 * app already knows to come back through — carrying the server's answer as
 * `mcp_` parameters for the app to send back under its own session.
 */
function handOff(client: ConnectionReturnClientV1, url: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.origin}${connectCallbackPathV1(client)}?${mcpReturnHandOffV1(url, false)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Trades the code for the User the state names, who the caller has already
 * checked is the one asking. The same answer delivered twice is the same
 * command, and is answered from its receipt rather than traded again.
 */
async function complete(
  host: McpGatewayHost,
  state: McpOAuthStateV1,
  answer: URLSearchParams,
  origin: string,
): Promise<{ ok: true } | { ok: false; line: string }> {
  const returned = new URL(MCP_OAUTH_CALLBACK_PATH, origin);
  for (const name of MCP_RETURN_PARAMETERS_V1) {
    const value = answer.get(name);
    if (value !== null) returned.searchParams.set(name, value);
  }
  try {
    const receipt = decodeConnectionCommandReceiptV1(
      await host.executeConnection(state.userId, {
        schemaVersion: 1,
        type: "connection/oauth",
        commandId: `mcp-return-${state.attemptId}`,
        attemptId: state.attemptId,
        packageId: MCP_PACKAGE_ID,
        action: "complete",
        connectionId: state.connectionId,
        code: returned.href,
      }),
    );
    return receipt.status === "applied"
      ? { ok: true }
      : { ok: false, line: receipt.oauth?.message ?? FAILED_LINE };
  } catch {
    return { ok: false, line: FAILED_LINE };
  }
}

async function verifiedState(
  host: McpGatewayHost,
  state: string | null,
): Promise<McpOAuthStateV1 | undefined> {
  return host.mcpSignInKeyring
    ? verifyMcpOAuthStateV1(
        host.mcpSignInKeyring,
        state,
        (host.now ?? Date.now)(),
      )
    : undefined;
}

async function callback(
  host: McpGatewayHost,
  request: Request,
  url: URL,
  client: ConnectionReturnClientV1 | undefined,
  sessionUserId: (() => Promise<string | undefined>) | undefined,
): Promise<Response> {
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  const state = await verifiedState(host, url.searchParams.get("state"));
  if (!state) {
    return signedInPage(url.origin, { ok: false, line: EXPIRED_LINE });
  }
  if (client !== undefined) return handOff(client, url);
  if ((await sessionUserId?.()) !== state.userId) {
    return elsewherePage(url.origin);
  }
  return signedInPage(
    url.origin,
    await complete(host, state, url.searchParams, url.origin),
  );
}

/**
 * An app sending back the answer its return page handed it. Its bearer is
 * the session; the state must name the same User.
 */
async function completeFromApp(
  host: McpGatewayHost,
  request: Request,
  url: URL,
  userId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "The sign-in answer is invalid.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return jsonError(400, "The sign-in answer is invalid.");
  }
  const answer = new URLSearchParams();
  for (const name of MCP_RETURN_PARAMETERS_V1) {
    const value = (body as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > MAX_RETURN_FIELD) {
      return jsonError(400, "The sign-in answer is invalid.");
    }
    answer.set(name, value);
  }
  const state = await verifiedState(host, answer.get("state"));
  if (!state) return jsonError(400, EXPIRED_LINE);
  if (state.userId !== userId) return jsonError(403, ELSEWHERE_LINE);
  const outcome = await complete(host, state, answer, url.origin);
  return Response.json({
    schemaVersion: 1,
    status: outcome.ok ? "ready" : "failed",
    connectionId: state.connectionId,
    ...(outcome.ok ? {} : { message: outcome.line }),
  });
}

async function authorize(
  host: McpGatewayHost,
  request: Request,
  url: URL,
  userId: string,
  connectionId: string,
): Promise<Response> {
  const command = decodeStartConnectionCommandV1(await request.json());
  if (command.connectionTypeId !== MCP_CONNECTION_TYPE_ID) {
    return jsonError(400, "This is not an MCP server.");
  }
  const receipt = decodeConnectionCommandReceiptV1(
    await host.executeConnection(userId, {
      schemaVersion: 1,
      type: "connection/oauth",
      commandId: command.commandId,
      attemptId: command.commandId,
      packageId: MCP_PACKAGE_ID,
      action: "start",
      connectionId,
      // Which return page the app can come back through; the origin is this
      // gateway's own, never the client's.
      callbackUrl: `${url.origin}${mcpOAuthCallbackPathV1(command.returnClient)}`,
    }),
  );
  const redirectUrl = receipt.oauth?.authorizationUrl;
  if (
    receipt.status !== "applied" ||
    !redirectUrl ||
    receipt.oauth?.expiresAt === undefined
  ) {
    return jsonError(
      400,
      receipt.oauth?.message ?? "This server can't be signed in to right now.",
    );
  }
  return Response.json({
    schemaVersion: 1,
    status: "authorization-required",
    connectionId,
    redirectUrl,
    expiresAt: new Date(receipt.oauth.expiresAt).toISOString(),
  });
}

/**
 * The Disconnect an installed app presses for a server with no token: it
 * sends every account that is not keyed to its Package's revoke door, which
 * for a server is removing it.
 */
async function revoke(
  host: McpGatewayHost,
  userId: string,
  connectionId: string,
): Promise<Response> {
  const receipt = decodeConnectionCommandReceiptV1(
    await host.executeConnection(userId, {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: `disconnect-${crypto.randomUUID()}`,
      connectionId,
      revokeUpstream: true,
    }),
  );
  if (receipt.status !== "applied") {
    return jsonError(400, "This server could not be removed.");
  }
  return Response.json({ schemaVersion: 1, status: "revoked" });
}

export function createMcpBackendContribution(
  host: McpGatewayHost,
): McpBackendRouteContribution {
  return {
    packageId: MCP_PACKAGE_ID,
    async publicRoute(request, url, context) {
      if (url.pathname === MCP_OAUTH_CLIENT_PATH) {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        return Response.json(mcpOAuthClientMetadataV1(url.origin), {
          headers: { "cache-control": "public, max-age=3600" },
        });
      }
      const client = mcpOAuthReturnClientV1(url.pathname);
      if (client === null) return undefined;
      return callback(host, request, url, client, context?.sessionUserId);
    },
    async route(request, url, context) {
      if (url.pathname === MCP_OAUTH_COMPLETE_PATH) {
        if (!context.userId) return jsonError(401, "authentication required");
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        return completeFromApp(host, request, url, context.userId);
      }
      const matched = CONNECTION_ROUTE.exec(url.pathname);
      if (!matched) return undefined;
      if (!context.userId) return jsonError(401, "authentication required");
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let connectionId: string;
      try {
        connectionId = decodeURIComponent(matched[1]!);
      } catch {
        return jsonError(400, "Connection is invalid");
      }
      if (!CONNECTION_ID.test(connectionId)) {
        return jsonError(400, "Connection is invalid");
      }
      try {
        return matched[2] === "authorize"
          ? await authorize(host, request, url, context.userId, connectionId)
          : await revoke(host, context.userId, connectionId);
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Connection request failed",
        );
      }
    },
  };
}

export const backendContribution = defineGatewayContribution<
  McpGatewayHost,
  McpBackendRouteContribution
>({
  specifier: "@frockbot/app/mcp/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createMcpBackendContribution(host)),
});
