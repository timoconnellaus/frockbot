import {
  decodeAdminUserListViewV1,
  decodeDeploymentPolicyV1,
  decodeSetSignupsCommandV1,
  decodeSetUserFeaturesCommandV1,
  decodeUserFeaturesV1,
  type AdminUserViewV1,
  type DeploymentPolicyV1,
  type SetSignupsCommandV1,
  type SetUserFeaturesCommandV1,
  type UserFeaturesV1,
} from "./shared.js";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import { isRpcIdentifier } from "@frockbot/core/configuration";

/** One account the identity store knows, before its features are read. */
export interface AdminListedUserV1 {
  userId: string;
  email?: string;
  name?: string;
}

export interface AdminGatewayHost {
  readDeploymentPolicy(): Promise<DeploymentPolicyV1>;
  setDeploymentSignups(
    command: SetSignupsCommandV1,
    updatedBy: string,
  ): Promise<DeploymentPolicyV1>;
  /** Every account the identity store holds, newest first. */
  listUsers(): Promise<AdminListedUserV1[]>;
  readUserFeatures(userId: string): Promise<UserFeaturesV1>;
  setUserFeatures(
    userId: string,
    command: SetUserFeaturesCommandV1,
    updatedBy: string,
  ): Promise<UserFeaturesV1>;
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

const USER_FEATURES_PATH = /^\/api\/admin\/users\/([^/]+)\/features$/;

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

function failure(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function routePolicy(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  updatedBy: string,
): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin policy query is invalid");
  }
  if (request.method === "GET") {
    try {
      return Response.json(
        decodeDeploymentPolicyV1(await host.readDeploymentPolicy()),
      );
    } catch (error) {
      return jsonError(500, failure(error, "Admin policy could not be read"));
    }
  }
  if (request.method !== "POST") {
    return jsonError(405, "method not allowed");
  }
  let command: SetSignupsCommandV1;
  try {
    command = decodeSetSignupsCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Admin policy was refused"));
  }
  try {
    return Response.json(
      decodeDeploymentPolicyV1(
        await host.setDeploymentSignups(command, updatedBy),
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
    return jsonError(500, failure(error, "Admin policy could not be changed"));
  }
}

/**
 * Every account, with what each holds. The signed-in admin is always in the
 * list: a development stack's identity has no row in the identity store, and
 * an admin who could not find their own account could not try a feature
 * before offering it to anyone else.
 */
async function routeUsers(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  adminUserId: string,
): Promise<Response> {
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin users query is invalid");
  }
  try {
    const listed = await host.listUsers();
    const accounts: AdminListedUserV1[] = listed.some(
      (user) => user.userId === adminUserId,
    )
      ? listed
      : [{ userId: adminUserId }, ...listed];
    const users: AdminUserViewV1[] = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        features: await host.readUserFeatures(account.userId),
      })),
    );
    return Response.json(
      decodeAdminUserListViewV1({ schemaVersion: 1, users }),
    );
  } catch (error) {
    return jsonError(500, failure(error, "Accounts could not be read"));
  }
}

async function routeUserFeatures(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  encodedUserId: string,
  updatedBy: string,
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin features query is invalid");
  }
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return jsonError(400, "Account id is invalid");
  }
  if (!isRpcIdentifier(userId)) return jsonError(400, "Account id is invalid");
  let command: SetUserFeaturesCommandV1;
  try {
    command = decodeSetUserFeaturesCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Account features were refused"));
  }
  try {
    return Response.json(
      decodeUserFeaturesV1(
        await host.setUserFeatures(userId, command, updatedBy),
      ),
    );
  } catch (error) {
    return jsonError(
      500,
      failure(error, "Account features could not be changed"),
    );
  }
}

export function createAdminBackendContribution(
  host: AdminGatewayHost,
): AdminBackendRouteContribution {
  return {
    packageId: "admin",
    async route(request, url, context) {
      if (!url.pathname.startsWith("/api/admin/")) return undefined;
      if (!context.userId || !context.isAdmin) {
        return jsonError(403, "Admin access is required");
      }
      if (url.pathname === "/api/admin/policy") {
        return routePolicy(request, url, host, context.userId);
      }
      if (url.pathname === "/api/admin/users") {
        return routeUsers(request, url, host, context.userId);
      }
      const features = url.pathname.match(USER_FEATURES_PATH);
      if (features) {
        return routeUserFeatures(
          request,
          url,
          host,
          features[1],
          context.userId,
        );
      }
      return jsonError(404, "not found");
    },
  };
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
  specifier: "@frockbot/app/admin/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createAdminBackendContribution(host)),
});
