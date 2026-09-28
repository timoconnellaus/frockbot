import { adminEmailsV1 } from "@frockbot/app/admin/shared";

export { adminEmailsV1 };

/** The one identity a development stack signs in as; an admin there. */
export const DEVELOPMENT_USER_ID = "development";

export interface GatewayIdentityV1 {
  id: string;
  email?: string;
  /** Whether the provider verified `email`; an unverified one names nobody. */
  emailVerified?: boolean;
  mode: "better-auth" | "development";
}

/**
 * The deployment's administrators by User id, as `FROCKBOT_ADMIN_USER_IDS`
 * spells them: comma-separated and trimmed. A User id is opaque, so it is
 * compared exactly. It is how a deployment whose people have no email names
 * an admin.
 */
export function adminUserIdsV1(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** The two allowlists, as the deployment's secrets carry them. */
export interface DeploymentAdminsV1 {
  emails?: string;
  userIds?: string;
}

export function isDeploymentAdminV1(
  identity: GatewayIdentityV1,
  configured: DeploymentAdminsV1,
): boolean {
  if (identity.mode === "development" && identity.id === DEVELOPMENT_USER_ID) {
    return true;
  }
  const userIds = adminUserIdsV1(configured.userIds);
  // A development id is whatever `?as_user=` said, so only a signed-in one counts.
  if (identity.mode === "better-auth" && userIds.has(identity.id)) return true;
  const emails = adminEmailsV1(configured.emails);
  if (
    identity.emailVerified === true &&
    identity.email &&
    emails.has(identity.email.trim().toLowerCase())
  ) {
    return true;
  }
  return (
    identity.mode === "development" && emails.size === 0 && userIds.size === 0
  );
}
