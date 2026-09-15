import { adminEmailsV1 } from "@frockbot/app/admin/shared";

export { adminEmailsV1 };

/** The one identity a development stack signs in as; an admin there. */
export const DEVELOPMENT_USER_ID = "development";

export interface GatewayIdentityV1 {
  id: string;
  email?: string;
  mode: "better-auth" | "development";
}

export function isDeploymentAdminV1(
  identity: GatewayIdentityV1,
  configuredEmails: string | undefined,
): boolean {
  if (identity.mode === "development" && identity.id === DEVELOPMENT_USER_ID) {
    return true;
  }
  const emails = adminEmailsV1(configuredEmails);
  if (identity.email && emails.has(identity.email.trim().toLowerCase())) {
    return true;
  }
  return identity.mode === "development" && emails.size === 0;
}
