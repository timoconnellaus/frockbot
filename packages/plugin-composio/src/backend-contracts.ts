export type StartConnectionResult =
  | {
      schemaVersion: 1;
      status: "authorization-required";
      connectionId: string;
      redirectUrl: string;
      expiresAt: string;
      nativeReturnNonce?: string;
    }
  | {
      schemaVersion: 1;
      status: "ready";
      connectionId: string;
      nativeReturnNonce?: string;
    };

export interface RevokeConnectionResult {
  schemaVersion: 1;
  status: "revoked" | "reconciliation-required";
}

export interface ConnectionCompletionResult {
  returnTarget: "browser" | "desktop";
  status: "ready" | "pending" | "failed";
  nativeReturnNonce?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function nonemptyString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function nativeReturnNonce(value: unknown): value is string | undefined {
  return value === undefined || nonemptyString(value, 128);
}

export function decodeStartConnectionResultV1(
  input: unknown,
): StartConnectionResult {
  const value = record(input);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !nonemptyString(value.connectionId, 128) ||
    !nativeReturnNonce(value.nativeReturnNonce)
  ) {
    throw new Error("Connection result is invalid");
  }
  if (value.status === "ready") {
    if (
      !hasExactKeys(
        value,
        ["schemaVersion", "status", "connectionId"],
        ["nativeReturnNonce"],
      )
    ) {
      throw new Error("Connection result is invalid");
    }
    return {
      schemaVersion: 1,
      status: "ready",
      connectionId: value.connectionId,
      ...(value.nativeReturnNonce === undefined
        ? {}
        : { nativeReturnNonce: value.nativeReturnNonce }),
    };
  }
  if (
    value.status !== "authorization-required" ||
    !hasExactKeys(
      value,
      ["schemaVersion", "status", "connectionId", "redirectUrl", "expiresAt"],
      ["nativeReturnNonce"],
    ) ||
    !nonemptyString(value.redirectUrl, 8_192) ||
    !nonemptyString(value.expiresAt, 64)
  ) {
    throw new Error("Connection result is invalid");
  }
  return {
    schemaVersion: 1,
    status: "authorization-required",
    connectionId: value.connectionId,
    redirectUrl: value.redirectUrl,
    expiresAt: value.expiresAt,
    ...(value.nativeReturnNonce === undefined
      ? {}
      : { nativeReturnNonce: value.nativeReturnNonce }),
  };
}

export function decodeRevokeConnectionResultV1(
  input: unknown,
): RevokeConnectionResult {
  const value = record(input);
  if (
    !value ||
    !hasExactKeys(value, ["schemaVersion", "status"]) ||
    value.schemaVersion !== 1 ||
    (value.status !== "revoked" && value.status !== "reconciliation-required")
  ) {
    throw new Error("revocation result is invalid");
  }
  return { schemaVersion: 1, status: value.status };
}
