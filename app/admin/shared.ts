export interface DeploymentPolicyV1 {
  schemaVersion: 1;
  revision: number;
  signups: { open: boolean };
  updatedAt: string;
  updatedBy: string;
}

export interface SetSignupsCommandV1 {
  schemaVersion: 1;
  type: "deployment/set-signups";
  open: boolean;
  revision: number;
}

export interface SetSignupsRequestV1 {
  schemaVersion: 1;
  command: SetSignupsCommandV1;
  updatedBy: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !keys.every((key) => expected.includes(key))
  ) {
    throw new Error(`${label} has unknown fields`);
  }
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new Error(`${label} is invalid`);
  }
  return timestamp;
}

export function decodeDeploymentPolicyV1(input: unknown): DeploymentPolicyV1 {
  const policy = record(input, "deployment policy");
  exactKeys(
    policy,
    ["schemaVersion", "revision", "signups", "updatedAt", "updatedBy"],
    "deployment policy",
  );
  if (policy.schemaVersion !== 1) {
    throw new Error("deployment policy.schemaVersion is invalid");
  }
  const signups = record(policy.signups, "deployment policy.signups");
  exactKeys(signups, ["open"], "deployment policy.signups");
  if (typeof signups.open !== "boolean") {
    throw new Error("deployment policy.signups.open is invalid");
  }
  return {
    schemaVersion: 1,
    revision: revision(policy.revision, "deployment policy.revision"),
    signups: { open: signups.open },
    updatedAt: isoTimestamp(policy.updatedAt, "deployment policy.updatedAt"),
    updatedBy: boundedString(
      policy.updatedBy,
      "deployment policy.updatedBy",
      512,
    ),
  };
}

export function decodeSetSignupsCommandV1(input: unknown): SetSignupsCommandV1 {
  const command = record(input, "deployment signup command");
  exactKeys(
    command,
    ["schemaVersion", "type", "open", "revision"],
    "deployment signup command",
  );
  if (
    command.schemaVersion !== 1 ||
    command.type !== "deployment/set-signups" ||
    typeof command.open !== "boolean"
  ) {
    throw new Error("deployment signup command is invalid");
  }
  return {
    schemaVersion: 1,
    type: "deployment/set-signups",
    open: command.open,
    revision: revision(command.revision, "deployment signup command.revision"),
  };
}

export function decodeDeploymentPolicyReadRequestV1(input: unknown): {
  schemaVersion: 1;
} {
  const request = record(input, "deployment policy read request");
  exactKeys(request, ["schemaVersion"], "deployment policy read request");
  if (request.schemaVersion !== 1) {
    throw new Error("deployment policy read request.schemaVersion is invalid");
  }
  return { schemaVersion: 1 };
}

export function decodeSetSignupsRequestV1(input: unknown): SetSignupsRequestV1 {
  const request = record(input, "deployment signup request");
  exactKeys(
    request,
    ["schemaVersion", "command", "updatedBy"],
    "deployment signup request",
  );
  if (request.schemaVersion !== 1) {
    throw new Error("deployment signup request.schemaVersion is invalid");
  }
  return {
    schemaVersion: 1,
    command: decodeSetSignupsCommandV1(request.command),
    updatedBy: boundedString(
      request.updatedBy,
      "deployment signup request.updatedBy",
      512,
    ),
  };
}

export class DeploymentPolicyConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`deployment policy revision is ${currentRevision}`);
    this.name = "DeploymentPolicyConflictError";
    this.currentRevision = currentRevision;
  }
}
