import type { Plugin } from "cordis";
import {
  decodeDeploymentPolicyV1,
  decodeSetSignupsCommandV1,
  type DeploymentPolicyV1,
  type SetSignupsCommandV1,
} from "./shared.js";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";

export interface AdminGatewayHost {
  readDeploymentPolicy(): Promise<DeploymentPolicyV1>;
  setDeploymentSignups(
    command: SetSignupsCommandV1,
    updatedBy: string,
  ): Promise<DeploymentPolicyV1>;
}

export interface AdminBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: {
      userId?: string;
      client: "browser" | "desktop";
      isAdmin: boolean;
    },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function isPolicyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "DeploymentPolicyConflictError"
  );
}

export function createAdminBackendContribution(
  host: AdminGatewayHost,
): AdminBackendRouteContribution {
  return {
    packageId: "admin",
    async route(request, url, context) {
      if (url.pathname !== "/api/admin/policy") return undefined;
      if (!context.userId || !context.isAdmin) {
        return jsonError(403, "Admin access is required");
      }
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "Admin policy query is invalid");
      }
      if (request.method === "GET") {
        try {
          return Response.json(
            decodeDeploymentPolicyV1(await host.readDeploymentPolicy()),
          );
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error
              ? error.message
              : "Admin policy could not be read",
          );
        }
      }
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      let command: SetSignupsCommandV1;
      try {
        command = decodeSetSignupsCommandV1(await request.json());
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Admin policy was refused",
        );
      }
      try {
        return Response.json(
          decodeDeploymentPolicyV1(
            await host.setDeploymentSignups(command, context.userId),
          ),
        );
      } catch (error) {
        if (isPolicyConflict(error)) {
          const current = decodeDeploymentPolicyV1(
            await host.readDeploymentPolicy(),
          );
          return Response.json(
            {
              error: `deployment policy revision is ${current.revision}`,
              code: "revision-conflict",
              currentRevision: current.revision,
            },
            { status: 409 },
          );
        }
        return jsonError(
          500,
          error instanceof Error
            ? error.message
            : "Admin policy could not be changed",
        );
      }
    },
  };
}

export namespace createAdminBackendContribution {
  export function plugin(
    host: AdminGatewayHost,
    lifecycle: { mount(value: AdminBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createAdminBackendContribution(host));
  }
}

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  AdminGatewayHost,
  AdminBackendRouteContribution
>({
  specifier: "@frockbot/plugin-admin/backend",
  create: createAdminBackendContribution.plugin,
});
