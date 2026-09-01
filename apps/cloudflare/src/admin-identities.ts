export interface GatewayIdentityV1 {
  id: string;
  email?: string;
  mode: "better-auth" | "development";
}

export function adminEmailsV1(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

export function isDeploymentAdminV1(
  identity: GatewayIdentityV1,
  configuredEmails: string | undefined,
): boolean {
  if (identity.mode === "development" && identity.id === "development") {
    return true;
  }
  const emails = adminEmailsV1(configuredEmails);
  if (identity.email && emails.has(identity.email.trim().toLowerCase())) {
    return true;
  }
  return identity.mode === "development" && emails.size === 0;
}
