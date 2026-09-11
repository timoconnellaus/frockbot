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

// --- Account features --------------------------------------------------------
//
// What an administrator has turned on for one account. Applets is the first:
// a feature that is off offers no `applet_*` tools to that account's Bots,
// mounts no Applet members into their Compositions, and shows no Applet
// surfaces in the client. The record is the account's, so the User Durable
// Object holds it; only an admin writes it.

export interface UserFeaturesV1 {
  schemaVersion: 1;
  applets: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface SetUserFeaturesCommandV1 {
  schemaVersion: 1;
  type: "user/set-features";
  applets: boolean;
}

export interface SetUserFeaturesRequestV1 {
  schemaVersion: 1;
  userId: string;
  command: SetUserFeaturesCommandV1;
  updatedBy: string;
}

/** One account as the admin list shows it: identity, and what it holds. */
export interface AdminUserViewV1 {
  userId: string;
  email?: string;
  name?: string;
  features: UserFeaturesV1;
}

export interface AdminUserListViewV1 {
  schemaVersion: 1;
  users: AdminUserViewV1[];
}

export const USER_FEATURES_DEFAULT_UPDATED_BY = "deployment-default";

export function defaultUserFeaturesV1(): UserFeaturesV1 {
  return {
    schemaVersion: 1,
    applets: false,
    updatedAt: new Date(0).toISOString(),
    updatedBy: USER_FEATURES_DEFAULT_UPDATED_BY,
  };
}

export function decodeUserFeaturesV1(input: unknown): UserFeaturesV1 {
  const features = record(input, "user features");
  exactKeys(
    features,
    ["schemaVersion", "applets", "updatedAt", "updatedBy"],
    "user features",
  );
  if (features.schemaVersion !== 1) {
    throw new Error("user features.schemaVersion is invalid");
  }
  if (typeof features.applets !== "boolean") {
    throw new Error("user features.applets is invalid");
  }
  return {
    schemaVersion: 1,
    applets: features.applets,
    updatedAt: isoTimestamp(features.updatedAt, "user features.updatedAt"),
    updatedBy: boundedString(
      features.updatedBy,
      "user features.updatedBy",
      512,
    ),
  };
}

export function decodeSetUserFeaturesCommandV1(
  input: unknown,
): SetUserFeaturesCommandV1 {
  const command = record(input, "user features command");
  exactKeys(
    command,
    ["schemaVersion", "type", "applets"],
    "user features command",
  );
  if (
    command.schemaVersion !== 1 ||
    command.type !== "user/set-features" ||
    typeof command.applets !== "boolean"
  ) {
    throw new Error("user features command is invalid");
  }
  return {
    schemaVersion: 1,
    type: "user/set-features",
    applets: command.applets,
  };
}

export function decodeUserFeaturesReadRequestV1(input: unknown): {
  schemaVersion: 1;
  userId: string;
} {
  const request = record(input, "user features read request");
  exactKeys(request, ["schemaVersion", "userId"], "user features read request");
  if (request.schemaVersion !== 1) {
    throw new Error("user features read request.schemaVersion is invalid");
  }
  return {
    schemaVersion: 1,
    userId: boundedString(
      request.userId,
      "user features read request.userId",
      512,
    ),
  };
}

export function decodeSetUserFeaturesRequestV1(
  input: unknown,
): SetUserFeaturesRequestV1 {
  const request = record(input, "user features request");
  exactKeys(
    request,
    ["schemaVersion", "userId", "command", "updatedBy"],
    "user features request",
  );
  if (request.schemaVersion !== 1) {
    throw new Error("user features request.schemaVersion is invalid");
  }
  return {
    schemaVersion: 1,
    userId: boundedString(request.userId, "user features request.userId", 512),
    command: decodeSetUserFeaturesCommandV1(request.command),
    updatedBy: boundedString(
      request.updatedBy,
      "user features request.updatedBy",
      512,
    ),
  };
}

function optionalDisplayString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maximum);
}

export function decodeAdminUserViewV1(input: unknown): AdminUserViewV1 {
  const user = record(input, "admin user");
  const keys = Object.keys(user);
  const allowed = ["userId", "email", "name", "features"];
  if (!keys.every((key) => allowed.includes(key))) {
    throw new Error("admin user has unknown fields");
  }
  const email = optionalDisplayString(user.email, 512);
  const name = optionalDisplayString(user.name, 512);
  return {
    userId: boundedString(user.userId, "admin user.userId", 512),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    features: decodeUserFeaturesV1(user.features),
  };
}

export function decodeAdminUserListViewV1(input: unknown): AdminUserListViewV1 {
  const view = record(input, "admin user list");
  exactKeys(view, ["schemaVersion", "users"], "admin user list");
  if (view.schemaVersion !== 1) {
    throw new Error("admin user list.schemaVersion is invalid");
  }
  if (!Array.isArray(view.users)) {
    throw new Error("admin user list.users is invalid");
  }
  return {
    schemaVersion: 1,
    users: view.users.map((user) => decodeAdminUserViewV1(user)),
  };
}
