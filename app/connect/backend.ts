// The Connected apps gateway Contribution.
//
// Two authenticated routes, both the ones the Connectors surface already
// presses for a hosted grant, and one public page:
//
//   POST /api/plugins/connect/connections                       start
//   POST /api/plugins/connect/connections/:connectionId/revoke  disconnect
//   GET  /api/connect/callback[/android|/macos]                 the return page
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
import { returnPageV1 } from "@frockbot/app/return-page";
import { connectCallbackPathV1, connectReturnClientV1 } from "./user.js";
import type { ConnectionReturnClientV1 } from "@frockbot/core/configuration";

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

/** The Mac app's custom scheme; the same one its sign-in return uses. */
const MACOS_SCHEME = "frockbot";

/**
 * The page a person lands on after the app's sign-in. No session, no state:
 * it says to go back, and the next settings read settles the Connection.
 *
 * Which way back depends on the page they were sent to. On Android the
 * verified App Link has already opened the app by the time this renders, and
 * the page is what the browser keeps. On a Mac no browser but Safari opens a
 * Universal Link from a redirect, so the page hands over on the app's scheme
 * with nothing from the query attached. A browser tab is told to return.
 */
export function connectCallbackPageV1(
  client: ConnectionReturnClientV1 | undefined,
  origin: string,
): Response {
  const heading = "Back to FrockBot";
  const footnote =
    "FrockBot shows whether the app connected. If it did not, connect it again from the Marketplace.";
  if (client === "macos") {
    const target = `${MACOS_SCHEME}://${new URL(origin).host}${connectCallbackPathV1("macos")}`;
    return returnPageV1({
      title: "Back to FrockBot",
      heading,
      lead: "Your browser is handing you back to the FrockBot app. Once it opens, you can close this tab.",
      status: "Opening FrockBot",
      action: { label: "Open FrockBot", href: target, id: "open" },
      footnote,
      script: `location.replace(${JSON.stringify(target)});`,
    });
  }
  if (client === "android") {
    return returnPageV1({
      title: "Back to FrockBot",
      heading,
      lead: "Head back to the FrockBot app. You can close this page.",
      footnote,
    });
  }
  return returnPageV1({
    title: "Back to FrockBot",
    heading,
    lead: "You can close this tab and return to FrockBot.",
    action: { label: "Open FrockBot", href: `${origin}/` },
    footnote,
  });
}

export function createConnectBackendContribution(
  host: ConnectGatewayHost,
): ConnectBackendRouteContribution {
  return {
    packageId: CONNECT_PACKAGE_ID,
    publicRoute(request, url) {
      const client = connectReturnClientV1(url.pathname);
      if (client === null) return Promise.resolve(undefined);
      if (request.method !== "GET") {
        return Promise.resolve(jsonError(405, "method not allowed"));
      }
      return Promise.resolve(connectCallbackPageV1(client, url.origin));
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
            // Which return page the client can come back through; the User
            // Durable Object keeps only the path and names its own origin.
            callbackUrl: `${url.origin}${connectCallbackPathV1(command.returnClient)}`,
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
