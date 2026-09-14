import {
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeAdminUserBillingV1,
  decodeAdminUserListViewV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  decodeGrantUserCreditCommandV1,
  decodeInviteEmailCommandV1,
  decodeSetAccountAccessCommandV1,
  decodeSetAdmissionModeCommandV1,
  decodeSetUserFeaturesCommandV1,
  decodeUserFeaturesV1,
  type AccountAccessV1,
  type AccountAccessViewV1,
  type AdminUserBillingV1,
  type AdminUserViewV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type GrantUserCreditCommandV1,
  type InviteEmailCommandV1,
  type SetAccountAccessCommandV1,
  type SetAdmissionModeCommandV1,
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
  /** Throws `DeploymentPolicyConflictError` when the revision is stale. */
  setAdmissionMode(
    command: SetAdmissionModeCommandV1,
    updatedBy: string,
  ): Promise<DeploymentPolicyV1>;
  readAccountAccess(userId: string): Promise<AccountAccessViewV1>;
  /** Throws `AccountAccessConflictError` when the revision is stale. */
  setAccountAccess(
    userId: string,
    command: SetAccountAccessCommandV1,
    updatedBy: string,
  ): Promise<AccountAccessV1>;
  inviteEmail(
    command: InviteEmailCommandV1,
    invitedBy: string,
  ): Promise<EmailInvitationV1>;
  /** Every account the identity store holds, newest first. */
  listUsers(): Promise<AdminListedUserV1[]>;
  readUserFeatures(userId: string): Promise<UserFeaturesV1>;
  setUserFeatures(
    userId: string,
    command: SetUserFeaturesCommandV1,
    updatedBy: string,
  ): Promise<UserFeaturesV1>;
  readUserBilling(userId: string): Promise<AdminUserBillingV1>;
  grantUserCredit(
    userId: string,
    command: GrantUserCreditCommandV1,
    grantedBy: string,
  ): Promise<AdminUserBillingV1>;
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
const USER_CREDIT_PATH = /^\/api\/admin\/users\/([^/]+)\/credit$/;
const USER_ACCESS_PATH = /^\/api\/admin\/users\/([^/]+)\/access$/;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function conflictRevision(error: unknown, name: string): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name &&
    "currentRevision" in error &&
    Number.isSafeInteger(error.currentRevision)
  ) {
    return error.currentRevision as number;
  }
  return undefined;
}

function conflictResponse(label: string, currentRevision: number): Response {
  return Response.json(
    {
      error: `${label} revision is ${currentRevision}`,
      code: "revision-conflict",
      currentRevision,
    },
    { status: 409 },
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
  let command: SetAdmissionModeCommandV1;
  try {
    command = decodeSetAdmissionModeCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Admin policy was refused"));
  }
  try {
    return Response.json(
      decodeDeploymentPolicyV1(await host.setAdmissionMode(command, updatedBy)),
    );
  } catch (error) {
    const current = conflictRevision(error, "DeploymentPolicyConflictError");
    if (current !== undefined) {
      return conflictResponse("deployment policy", current);
    }
    return jsonError(500, failure(error, "Admin policy could not be changed"));
  }
}

/**
 * One account's beta access. There is no list of these: the admin page does
 * not show them yet, and the seam exists so an admin can pause, end, block or
 * grant an account without anyone editing storage by hand.
 */
async function routeUserAccess(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  encodedUserId: string,
  updatedBy: string,
): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin access query is invalid");
  }
  const userId = decodeAccountId(encodedUserId);
  if (!userId) return jsonError(400, "Account id is invalid");
  if (request.method === "GET") {
    try {
      return Response.json(
        decodeAccountAccessViewV1(await host.readAccountAccess(userId)),
      );
    } catch (error) {
      return jsonError(500, failure(error, "Account access could not be read"));
    }
  }
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  let command: SetAccountAccessCommandV1;
  try {
    command = decodeSetAccountAccessCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Account access was refused"));
  }
  try {
    return Response.json(
      decodeAccountAccessV1(
        await host.setAccountAccess(userId, command, updatedBy),
      ),
    );
  } catch (error) {
    const current = conflictRevision(error, "AccountAccessConflictError");
    if (current !== undefined) {
      return conflictResponse("account access", current);
    }
    return jsonError(
      500,
      failure(error, "Account access could not be changed"),
    );
  }
}

/**
 * Invites an address that may not have signed in yet. Only a sign-in whose
 * identity provider verified that address can redeem it.
 */
async function routeInvitations(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  invitedBy: string,
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin invitation query is invalid");
  }
  let command: InviteEmailCommandV1;
  try {
    command = decodeInviteEmailCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Invitation was refused"));
  }
  try {
    return Response.json(
      decodeEmailInvitationV1(await host.inviteEmail(command, invitedBy)),
    );
  } catch (error) {
    return jsonError(500, failure(error, "Invitation could not be written"));
  }
}

/**
 * Every account, with what each holds. The signed-in admin is always in the
 * list: a development stack's identity has no row in the identity store, and
 * an admin who could not find their own account could not try a feature
 * before offering it to anyone else.
 *
 * Each account's features come from its own User Durable Object, so one read
 * can fail while the rest answer. A failed read marks that one account
 * unavailable rather than failing the list or reporting a default: the admin
 * sees every other switch, and the unreadable account is shown as unreadable,
 * never as off.
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
    const [reads, balances] = await Promise.all([
      Promise.allSettled(
        accounts.map((account) => host.readUserFeatures(account.userId)),
      ),
      Promise.allSettled(
        accounts.map((account) => host.readUserBilling(account.userId)),
      ),
    ]);
    const users: AdminUserViewV1[] = accounts.map((account, index) => {
      const read = reads[index];
      const balance = balances[index];
      return {
        ...account,
        features:
          read?.status === "fulfilled" ? read.value : { unavailable: true },
        billing:
          balance?.status === "fulfilled"
            ? balance.value
            : { unavailable: true },
      };
    });
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

function decodeAccountId(encoded: string): string | undefined {
  let userId: string;
  try {
    userId = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  return isRpcIdentifier(userId) ? userId : undefined;
}

/**
 * Credit an admin gives by hand. The command carries the admin's own id for
 * the grant, so the ledger grants once however many times the request lands.
 */
async function routeUserCredit(
  request: Request,
  url: URL,
  host: AdminGatewayHost,
  encodedUserId: string,
  grantedBy: string,
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  if ([...url.searchParams.keys()].length > 0) {
    return jsonError(400, "Admin credit query is invalid");
  }
  const userId = decodeAccountId(encodedUserId);
  if (!userId) return jsonError(400, "Account id is invalid");
  let command: GrantUserCreditCommandV1;
  try {
    command = decodeGrantUserCreditCommandV1(await request.json());
  } catch (error) {
    return jsonError(400, failure(error, "Credit grant was refused"));
  }
  try {
    return Response.json(
      decodeAdminUserBillingV1(
        await host.grantUserCredit(userId, command, grantedBy),
      ),
    );
  } catch (error) {
    return jsonError(500, failure(error, "Credit could not be granted"));
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
      if (url.pathname === "/api/admin/invitations") {
        return routeInvitations(request, url, host, context.userId);
      }
      const access = url.pathname.match(USER_ACCESS_PATH);
      if (access) {
        return routeUserAccess(request, url, host, access[1], context.userId);
      }
      const credit = url.pathname.match(USER_CREDIT_PATH);
      if (credit) {
        return routeUserCredit(request, url, host, credit[1], context.userId);
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
