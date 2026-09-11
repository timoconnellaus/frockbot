// The Connected apps gateway Contribution.
//
// Two authenticated routes, both the ones the Connectors surface already
// presses for a hosted grant, and one public page:
//
//   POST /api/plugins/connect/connections                       start
//   POST /api/plugins/connect/connections/:connectionId/revoke  disconnect
//   GET  /api/connect/callback                                  the return page
//
// The start is a `connection/oauth` command in the User Durable Object, which
// is where the sign-in link is minted and the Connection written; this route
// only translates the receipt into the answer the client opens. The return
// page is public because the person arrives on it by redirect from the app's
// own sign-in with no session in hand — and for that reason it touches no
// Durable Object at all. It says to go back; the next settings read settles
// the Connection.
import {
  decodeConnectionCommandReceiptV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/core/connection";
import { decodeStartConnectionCommandV1 } from "@frockbot/core/configuration";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import {
  CONNECT_PACKAGE_ID,
  connectToolkitForConnectionTypeV1,
} from "./catalog.js";
import { CONNECT_CALLBACK_PATH } from "./user.js";

export interface ConnectGatewayHost {
  executeConnection(
    userId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1>;
}

export interface ConnectBackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client?: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const START = `/api/plugins/${CONNECT_PACKAGE_ID}/connections`;
const REVOKE = new RegExp(
  `^/api/plugins/${CONNECT_PACKAGE_ID}/connections/([^/]+)/revoke$`,
);
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The page a person lands on after the app's sign-in. No session, no state. */
export function connectCallbackPageV1(url: URL): Response {
  const status = (url.searchParams.get("status") ?? "").toLowerCase();
  const failed = ["failed", "error", "expired", "cancelled", "canceled"].some(
    (word) => status.includes(word),
  );
  const heading = failed ? "That didn't finish" : "Connected";
  const line = failed
    ? "The sign-in didn't complete. Go back to FrockBot and try connecting again."
    : "Go back to FrockBot. The app is now available to every one of your Bots.";
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(heading)} · FrockBot</title><style nonce="${nonce}">body{font:17px system-ui;background:#faf8f4;color:#242323;max-width:38rem;margin:10vh auto;padding:24px}h1{font-size:1.6rem}</style><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(line)}</p></main></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}

export function createConnectBackendContribution(
  host: ConnectGatewayHost,
): ConnectBackendRouteContribution {
  return {
    packageId: CONNECT_PACKAGE_ID,
    publicRoute(request, url) {
      if (url.pathname !== CONNECT_CALLBACK_PATH)
        return Promise.resolve(undefined);
      if (request.method !== "GET") {
        return Promise.resolve(jsonError(405, "method not allowed"));
      }
      return Promise.resolve(connectCallbackPageV1(url));
    },
    async route(request, url, context) {
      const revoke = REVOKE.exec(url.pathname);
      if (url.pathname !== START && !revoke) return undefined;
      if (!context.userId) return jsonError(401, "authentication required");
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        if (revoke) {
          const connectionId = decodeURIComponent(revoke[1]!);
          if (!CONNECTION_ID.test(connectionId)) {
            return jsonError(400, "Connection is invalid");
          }
          const receipt = decodeConnectionCommandReceiptV1(
            await host.executeConnection(context.userId, {
              schemaVersion: 1,
              type: "connection/disconnect",
              commandId: `disconnect-${crypto.randomUUID()}`,
              connectionId,
              revokeUpstream: true,
            }),
          );
          if (receipt.status !== "applied") {
            return jsonError(400, "This app could not be disconnected.");
          }
          return Response.json({ schemaVersion: 1, status: "revoked" });
        }
        const command = decodeStartConnectionCommandV1(await request.json());
        if (!connectToolkitForConnectionTypeV1(command.connectionTypeId)) {
          return jsonError(400, "This app is not one FrockBot can connect.");
        }
        const receipt = decodeConnectionCommandReceiptV1(
          await host.executeConnection(context.userId, {
            schemaVersion: 1,
            type: "connection/oauth",
            commandId: command.commandId,
            attemptId: command.commandId,
            packageId: CONNECT_PACKAGE_ID,
            action: "start",
            connectionTypeId: command.connectionTypeId,
          }),
        );
        const redirectUrl = receipt.oauth?.authorizationUrl;
        if (receipt.status !== "applied" || !redirectUrl) {
          return jsonError(
            400,
            "Connecting apps isn't available right now. Try again later.",
          );
        }
        return Response.json({
          schemaVersion: 1,
          status: "authorization-required",
          connectionId: receipt.connectionId,
          redirectUrl,
          expiresAt: new Date(receipt.oauth!.expiresAt!).toISOString(),
        });
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
  ConnectGatewayHost,
  ConnectBackendRouteContribution
>({
  specifier: "@frockbot/app/connect/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createConnectBackendContribution(host)),
});
