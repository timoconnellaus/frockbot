/** Public OAuth progress contains no access tokens, refresh tokens, or PKCE verifier. */
export interface ModelOAuthProgressV1 {
  browserKey?: string;
  attemptId: string;
  status: "waiting" | "ready" | "failed" | "cancelled";
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: number;
  pollAfterMs?: number;
  manualCode?: boolean;
  message?: string;
}
export interface ModelOAuthCommandV1 {
  schemaVersion: 1;
  type: "connection/oauth";
  commandId: string;
  packageId: string;
  action: "start" | "check" | "complete" | "cancel";
  browserKey?: string;
  attemptId: string;
  label?: string;
  code?: string;
  /** Set by the authenticated gateway, never taken from client input. */
  callbackUrl?: string;
}
export function decodeModelOAuthProgressV1(
  input: unknown,
): ModelOAuthProgressV1 {
  const v = input as Record<string, unknown>;
  const fields = [
    "browserKey",
    "attemptId",
    "status",
    "authorizationUrl",
    "userCode",
    "expiresAt",
    "pollAfterMs",
    "manualCode",
    "message",
  ];
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !fields.includes(k)) ||
    typeof v.attemptId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(v.attemptId) ||
    !["waiting", "ready", "failed", "cancelled"].includes(v.status as string)
  )
    throw new Error("Invalid OAuth progress");
  for (const key of ["browserKey", "authorizationUrl", "userCode", "message"])
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "string" || (v[key] as string).length > 8192)
    )
      throw new Error("Invalid OAuth progress");
  if (
    v.authorizationUrl !== undefined &&
    new URL(v.authorizationUrl as string).protocol !== "https:"
  )
    throw new Error("Invalid OAuth authorization URL");
  for (const key of ["expiresAt", "pollAfterMs"])
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "number" ||
        !Number.isFinite(v[key]) ||
        (v[key] as number) < 0)
    )
      throw new Error("Invalid OAuth timing");
  if (v.manualCode !== undefined && typeof v.manualCode !== "boolean")
    throw new Error("Invalid OAuth progress");
  return { ...v } as unknown as ModelOAuthProgressV1;
}
