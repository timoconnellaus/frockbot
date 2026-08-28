export interface StartConnectionResult {
  connectionId: string;
  redirectUrl: string;
  expiresAt: string;
  nativeReturnNonce?: string;
}

export interface RevokeConnectionResult {
  status: "revoked" | "reconciliation-required";
}

export interface ConnectionCompletionResult {
  returnTarget: "browser" | "desktop";
  status: "ready" | "pending";
  nativeReturnNonce?: string;
}
