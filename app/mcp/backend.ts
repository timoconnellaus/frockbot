// The gateway's MCP server routes: signing in to a server, the Disconnect an
// installed app presses, the page an authorization server sends the person
// back to, and FrockBot's client metadata document.
//
//   POST /api/plugins/mcp/connections/:connectionId/authorize   start a sign-in
//   POST /api/plugins/mcp/connections/:connectionId/revoke      remove a server
//   GET  /api/mcp/oauth/callback[/android|/macos|/macos-dev]    the return page
//   GET  /api/mcp/oauth/client                                  client metadata
//
// The callback is public: an authorization server redirects a browser that
// carries no session. So the User it acts for comes from the signed state
// and from nowhere else, and that state is verified here, before any Durable
// Object is addressed — an anonymous request must not choose which object is
// woken. The User object then holds the attempt the state names and trades
// its code once.
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
  MCP_OAUTH_CLIENT_PATH,
  mcpOAuthCallbackPathV1,
  mcpOAuthClientMetadataV1,
  mcpOAuthReturnClientV1,
} from "./oauth.js";
import { verifyMcpOAuthStateV1 } from "./oauth-state.js";

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
  publicRoute(request: Request, url: URL): Promise<Response | undefined>;
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

/**
 * Where the person lands once the server's sign-in is done. An app's own
 * page is the Connect return page for that app — the one an installed app
 * already knows to come back through — so the redirect carries nothing from
 * the sign-in; the app reads how it went from its next settings read. A
 * browser tab is told here.
 */
function signedInPage(
  client: ConnectionReturnClientV1 | undefined,
  origin: string,
  outcome: { ok: true } | { ok: false; line: string },
): Response {
  if (client !== undefined) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `${origin}${connectCallbackPathV1(client)}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
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

async function callback(
  host: McpGatewayHost,
  request: Request,
  url: URL,
  client: ConnectionReturnClientV1 | undefined,
): Promise<Response> {
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  const now = (host.now ?? Date.now)();
  const state = host.mcpSignInKeyring
    ? await verifyMcpOAuthStateV1(
        host.mcpSignInKeyring,
        url.searchParams.get("state"),
        now,
      )
    : undefined;
  if (!state) {
    return signedInPage(undefined, url.origin, {
      ok: false,
      line: "This sign-in link has expired or isn't one FrockBot made.",
    });
  }
  try {
    const receipt = decodeConnectionCommandReceiptV1(
      await host.executeConnection(state.userId, {
        schemaVersion: 1,
        type: "connection/oauth",
        // The same callback delivered twice is the same command, and is
        // answered from its receipt rather than traded again.
        commandId: `mcp-return-${state.attemptId}`,
        attemptId: state.attemptId,
        packageId: MCP_PACKAGE_ID,
        action: "complete",
        connectionId: state.connectionId,
        code: url.href,
      }),
    );
    return signedInPage(
      client,
      url.origin,
      receipt.status === "applied"
        ? { ok: true }
        : {
            ok: false,
            line:
              receipt.oauth?.message ??
              "The sign-in couldn't finish. Sign in again.",
          },
    );
  } catch {
    return signedInPage(client, url.origin, {
      ok: false,
      line: "The sign-in couldn't finish. Sign in again.",
    });
  }
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
    async publicRoute(request, url) {
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
      return callback(host, request, url, client);
    },
    async route(request, url, context) {
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
