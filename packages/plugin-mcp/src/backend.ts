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
import type { Plugin } from "cordis";
import {
  decodeMcpLifecycleReceiptV1,
  decodeMcpServerStatusViewV1,
  type McpLifecycleReceiptV1,
  type McpServerStatusViewV1,
} from "./records.js";
import { MCP_PACKAGE_ID } from "./agent.js";

export const MCP_SERVERS_ROUTE = "/api/mcp/servers";

export interface McpGatewayHost {
  readMcpServers(userId: string): Promise<McpServerStatusViewV1>;
  executeMcpCommand(
    userId: string,
    command: unknown,
  ): Promise<McpLifecycleReceiptV1>;
}

export interface McpBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function createMcpBackendContribution(
  host: McpGatewayHost,
): McpBackendRouteContribution {
  return {
    packageId: MCP_PACKAGE_ID,
    async route(request, url, context) {
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
}

export namespace createMcpBackendContribution {
  export function plugin(
    host: McpGatewayHost,
    lifecycle: { mount(value: McpBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createMcpBackendContribution(host));
  }
}
