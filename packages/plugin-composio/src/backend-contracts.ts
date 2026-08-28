export interface StartConnectionResult {
  connectionId: string;
  redirectUrl: string;
  expiresAt: string;
}

export interface RevokeConnectionResult {
  status: "revoked" | "reconciliation-required";
}

export interface ConnectionCompletionResult {
  returnTarget: "browser" | "desktop";
}
