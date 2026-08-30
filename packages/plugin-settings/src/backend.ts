import { isPublicIdentifier } from "@frockbot/configuration-core";
import {
  decodeConnectionCommandIdV1,
  decodeConnectionCommandReceiptV1,
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";

export interface SettingsConnectionGatewayHost {
  executeConnection(
    userId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1>;
  lookupConnectionCommand(
    userId: string,
    packageId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined>;
}

export interface SettingsBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function createSettingsBackendContribution(
  host: SettingsConnectionGatewayHost,
): SettingsBackendRouteContribution {
  return {
    packageId: "settings",
    async route(request, url, context) {
      if (
        url.pathname !== "/api/connections" &&
        url.pathname !== "/api/connection-commands"
      ) {
        return undefined;
      }
      if (!context.userId) return undefined;
      if (url.pathname === "/api/connection-commands") {
        if (request.method !== "GET")
          return jsonError(405, "method not allowed");
        const queryFields = [...url.searchParams.keys()];
        const packageId = url.searchParams.get("packageId");
        const commandId = url.searchParams.get("commandId");
        if (
          queryFields.length !== 2 ||
          url.searchParams.getAll("packageId").length !== 1 ||
          url.searchParams.getAll("commandId").length !== 1 ||
          queryFields.some(
            (field) => field !== "packageId" && field !== "commandId",
          ) ||
          !isPublicIdentifier(packageId)
        ) {
          return jsonError(400, "invalid Connection command lookup");
        }
        try {
          const receipt = await host.lookupConnectionCommand(
            context.userId,
            packageId,
            decodeConnectionCommandIdV1(commandId),
          );
          return Response.json(
            receipt === undefined
              ? null
              : decodeConnectionCommandReceiptV1(receipt),
          );
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error
              ? error.message
              : "Connection command lookup failed",
          );
        }
      }
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        const command = decodeConnectionCommandV1(await request.json());
        return Response.json(
          decodeConnectionCommandReceiptV1(
            await host.executeConnection(context.userId, command),
          ),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Connection command failed",
        );
      }
    },
  };
}

export namespace createSettingsBackendContribution {
  export function plugin(
    host: SettingsConnectionGatewayHost,
    lifecycle: { mount(value: SettingsBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createSettingsBackendContribution(host));
  }
}
