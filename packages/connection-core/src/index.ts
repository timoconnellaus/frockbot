export * from "./authorization-state.js";
export * from "./credentials.js";
export * from "./models.js";

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

export interface ConnectionDependencyRequirementV1 {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  capabilityId: string;
  connectionTypeIds: string[];
}

export type ConnectionDependencyCommandV1 =
  | {
      schemaVersion: 1;
      action: "claim";
      operationId: string;
      userId: string;
      packageId: string;
      connectionId: string;
      botId: string;
      generation: string;
      requirement: ConnectionDependencyRequirementV1;
    }
  | {
      schemaVersion: 1;
      action: "read" | "acknowledge" | "release" | "reconcile";
      operationId: string;
      userId: string;
      packageId: string;
      connectionId: string;
      botId: string;
      generation: string;
    };

export type ConnectionDependencyResultV1 =
  | { schemaVersion: 1; status: "claimed" | "acknowledged" | "released" }
  | {
      schemaVersion: 1;
      status: "pending" | "unavailable" | "absent" | "rejected";
      failure?: string;
    };

export interface ConnectionDependencyOwner {
  readonly packageId: string;
  executeDependency(
    command: ConnectionDependencyCommandV1,
  ): Promise<ConnectionDependencyResultV1>;
}

/** Routes dependency commands only to the Contribution owning the Connection Package. */
export class ConnectionDependencyRouter {
  private readonly owners = new Map<string, ConnectionDependencyOwner>();

  register(owner: ConnectionDependencyOwner): () => void {
    if (this.owners.has(owner.packageId)) {
      throw new Error(
        `Connection dependency owner "${owner.packageId}" is already registered`,
      );
    }
    this.owners.set(owner.packageId, owner);
    return () => {
      if (this.owners.get(owner.packageId) === owner)
        this.owners.delete(owner.packageId);
    };
  }

  async execute(
    packageId: string,
    input: unknown,
  ): Promise<ConnectionDependencyResultV1> {
    const command = decodeConnectionDependencyCommandV1(input);
    const owner = this.owners.get(packageId);
    if (!owner) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        failure: `Connection Package "${packageId}" has no backend Contribution`,
      };
    }
    return decodeConnectionDependencyResultV1(
      await owner.executeDependency(command),
    );
  }
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
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
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

function dependencyIdentity(value: Record<string, unknown>) {
  for (const key of [
    "operationId",
    "userId",
    "packageId",
    "connectionId",
    "botId",
    "generation",
  ] as const) {
    if (!nonemptyString(value[key], 128)) {
      throw new Error(`Connection dependency ${key} is invalid`);
    }
  }
  return {
    operationId: value.operationId as string,
    userId: value.userId as string,
    packageId: value.packageId as string,
    connectionId: value.connectionId as string,
    botId: value.botId as string,
    generation: value.generation as string,
  };
}

function dependencyRequirement(
  input: unknown,
): ConnectionDependencyRequirementV1 {
  const value = record(input);
  if (
    !value ||
    !hasExactKeys(value, [
      "schemaVersion",
      "packageId",
      "packageVersion",
      "capabilityId",
      "connectionTypeIds",
    ]) ||
    value.schemaVersion !== 1 ||
    !nonemptyString(value.packageId, 128) ||
    !nonemptyString(value.packageVersion, 100) ||
    !nonemptyString(value.capabilityId, 128) ||
    !Array.isArray(value.connectionTypeIds) ||
    value.connectionTypeIds.length === 0 ||
    value.connectionTypeIds.length > 64 ||
    !value.connectionTypeIds.every((item) => nonemptyString(item, 128))
  ) {
    throw new Error("Connection dependency requirement is invalid");
  }
  return {
    schemaVersion: 1,
    packageId: value.packageId,
    packageVersion: value.packageVersion,
    capabilityId: value.capabilityId,
    connectionTypeIds: [...value.connectionTypeIds],
  };
}

export function decodeConnectionDependencyCommandV1(
  input: unknown,
): ConnectionDependencyCommandV1 {
  const value = record(input);
  if (!value || value.schemaVersion !== 1) {
    throw new Error("Connection dependency command is invalid");
  }
  const base = [
    "schemaVersion",
    "action",
    "operationId",
    "userId",
    "packageId",
    "connectionId",
    "botId",
    "generation",
  ];
  if (value.action === "claim") {
    if (!hasExactKeys(value, [...base, "requirement"])) {
      throw new Error("Connection dependency command is invalid");
    }
    return {
      schemaVersion: 1,
      action: "claim",
      ...dependencyIdentity(value),
      requirement: dependencyRequirement(value.requirement),
    };
  }
  if (
    value.action !== "read" &&
    value.action !== "acknowledge" &&
    value.action !== "release" &&
    value.action !== "reconcile"
  ) {
    throw new Error("Connection dependency command is invalid");
  }
  if (!hasExactKeys(value, base)) {
    throw new Error("Connection dependency command is invalid");
  }
  return {
    schemaVersion: 1,
    action: value.action,
    ...dependencyIdentity(value),
  };
}

export function decodeConnectionDependencyResultV1(
  input: unknown,
): ConnectionDependencyResultV1 {
  const value = record(input);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    (value.status !== "claimed" &&
      value.status !== "acknowledged" &&
      value.status !== "released" &&
      value.status !== "pending" &&
      value.status !== "unavailable" &&
      value.status !== "absent" &&
      value.status !== "rejected") ||
    !hasExactKeys(value, ["schemaVersion", "status"], ["failure"]) ||
    (value.failure !== undefined && !nonemptyString(value.failure, 512))
  ) {
    throw new Error("Connection dependency result is invalid");
  }
  if (
    (value.status === "claimed" ||
      value.status === "acknowledged" ||
      value.status === "released") &&
    value.failure !== undefined
  ) {
    throw new Error("Connection dependency result is invalid");
  }
  return value.failure === undefined
    ? { schemaVersion: 1, status: value.status }
    : { schemaVersion: 1, status: value.status, failure: value.failure };
}
