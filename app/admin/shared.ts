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
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    !expected.every((key) => keys.includes(key)) ||
    !keys.every((key) => expected.includes(key) || optional.includes(key))
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
  /** Whether this account's Bots may author Plugins (ADR 0026's master toggle). */
  pluginAuthoring: boolean;
  /** The admin-gated seeded Plugins an admin has opened for this account. */
  plugins: string[];
  updatedAt: string;
  updatedBy: string;
}

export interface SetUserFeaturesCommandV1 {
  schemaVersion: 1;
  type: "user/set-features";
  applets: boolean;
  pluginAuthoring?: boolean;
  plugins?: string[];
}

export interface SetUserFeaturesRequestV1 {
  schemaVersion: 1;
  userId: string;
  command: SetUserFeaturesCommandV1;
  updatedBy: string;
}

/**
 * An account whose features could not be read when the list was built. It is
 * not "off": off is a value the account's record holds, and this account's
 * record could not be reached. The list carries the account anyway so one
 * unreachable User Durable Object never hides every other account's switch.
 */
export interface UserFeaturesUnavailableV1 {
  unavailable: true;
}

export type AdminUserFeaturesV1 = UserFeaturesV1 | UserFeaturesUnavailableV1;

// --- Account credit -----------------------------------------------------------
//
// What an account can spend, and the one write an admin makes against it: a
// complimentary grant. The ledger is the account's, in its User Durable
// Object; the admin only ever adds to it, by an id the admin chose, so a
// repeated tap grants once.

export interface AdminUserBillingV1 {
  includedMicros: number;
  purchasedMicros: number;
  complimentaryMicros: number;
  reservedMicros: number;
  subscribed: boolean;
  canSpend: boolean;
  suspended: boolean;
}

export interface AdminUserBillingUnavailableV1 {
  unavailable: true;
}

export type AdminUserBillingViewV1 =
  AdminUserBillingV1 | AdminUserBillingUnavailableV1;

export interface GrantUserCreditCommandV1 {
  schemaVersion: 1;
  type: "user/grant-credit";
  /** The admin's idempotency key for this one grant. */
  id: string;
  cents: number;
  reason: string;
}

export interface GrantUserCreditRequestV1 {
  schemaVersion: 1;
  userId: string;
  command: GrantUserCreditCommandV1;
  grantedBy: string;
}

/** The most one hand-grant may be: a guard against a slipped digit. */
export const GRANT_USER_CREDIT_MAXIMUM_CENTS = 100_000;

/** One account as the admin list shows it: identity, and what it holds. */
export interface AdminUserViewV1 {
  userId: string;
  email?: string;
  name?: string;
  features: AdminUserFeaturesV1;
  billing: AdminUserBillingViewV1;
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
    pluginAuthoring: false,
    plugins: [],
    updatedAt: new Date(0).toISOString(),
    updatedBy: USER_FEATURES_DEFAULT_UPDATED_BY,
  };
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;

function pluginIds(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${label} must be a bounded array`);
  }
  const ids = value.map((entry, index) => {
    const id = boundedString(entry, `${label}[${index}]`, 64);
    if (!PLUGIN_ID.test(id)) throw new Error(`${label}[${index}] is invalid`);
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return ids.toSorted();
}

export function decodeUserFeaturesV1(input: unknown): UserFeaturesV1 {
  const features = record(input, "user features");
  // The two Plugin fields arrived after the record did (ADR 0026); a record
  // written without them reads as closed and none opened.
  exactKeys(
    features,
    ["schemaVersion", "applets", "updatedAt", "updatedBy"],
    "user features",
    ["pluginAuthoring", "plugins"],
  );
  if (features.schemaVersion !== 1) {
    throw new Error("user features.schemaVersion is invalid");
  }
  if (typeof features.applets !== "boolean") {
    throw new Error("user features.applets is invalid");
  }
  if (
    features.pluginAuthoring !== undefined &&
    typeof features.pluginAuthoring !== "boolean"
  ) {
    throw new Error("user features.pluginAuthoring is invalid");
  }
  return {
    schemaVersion: 1,
    applets: features.applets,
    pluginAuthoring: features.pluginAuthoring === true,
    plugins: pluginIds(features.plugins, "user features.plugins"),
    updatedAt: isoTimestamp(features.updatedAt, "user features.updatedAt"),
    updatedBy: boundedString(
      features.updatedBy,
      "user features.updatedBy",
      512,
    ),
  };
}

export function isUserFeaturesUnavailable(
  features: AdminUserFeaturesV1,
): features is UserFeaturesUnavailableV1 {
  return "unavailable" in features;
}

/** The exact unavailable marker, or the exact features record; nothing between. */
export function decodeAdminUserFeaturesV1(input: unknown): AdminUserFeaturesV1 {
  const features = record(input, "admin user features");
  if ("unavailable" in features) {
    exactKeys(features, ["unavailable"], "admin user features");
    if (features.unavailable !== true) {
      throw new Error("admin user features.unavailable is invalid");
    }
    return { unavailable: true };
  }
  return decodeUserFeaturesV1(features);
}

export function decodeSetUserFeaturesCommandV1(
  input: unknown,
): SetUserFeaturesCommandV1 {
  const command = record(input, "user features command");
  exactKeys(
    command,
    ["schemaVersion", "type", "applets"],
    "user features command",
    ["pluginAuthoring", "plugins"],
  );
  if (
    command.schemaVersion !== 1 ||
    command.type !== "user/set-features" ||
    typeof command.applets !== "boolean" ||
    (command.pluginAuthoring !== undefined &&
      typeof command.pluginAuthoring !== "boolean")
  ) {
    throw new Error("user features command is invalid");
  }
  return {
    schemaVersion: 1,
    type: "user/set-features",
    applets: command.applets,
    ...(command.pluginAuthoring === undefined
      ? {}
      : { pluginAuthoring: command.pluginAuthoring }),
    ...(command.plugins === undefined
      ? {}
      : {
          plugins: pluginIds(command.plugins, "user features command.plugins"),
        }),
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

function micros(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

export function decodeAdminUserBillingV1(input: unknown): AdminUserBillingV1 {
  const billing = record(input, "admin user billing");
  exactKeys(
    billing,
    [
      "includedMicros",
      "purchasedMicros",
      "complimentaryMicros",
      "reservedMicros",
      "subscribed",
      "canSpend",
      "suspended",
    ],
    "admin user billing",
  );
  for (const flag of ["subscribed", "canSpend", "suspended"]) {
    if (typeof billing[flag] !== "boolean") {
      throw new Error(`admin user billing.${flag} is invalid`);
    }
  }
  return {
    includedMicros: micros(
      billing.includedMicros,
      "admin user billing.includedMicros",
    ),
    purchasedMicros: micros(
      billing.purchasedMicros,
      "admin user billing.purchasedMicros",
    ),
    complimentaryMicros: micros(
      billing.complimentaryMicros,
      "admin user billing.complimentaryMicros",
    ),
    reservedMicros: micros(
      billing.reservedMicros,
      "admin user billing.reservedMicros",
    ),
    subscribed: billing.subscribed as boolean,
    canSpend: billing.canSpend as boolean,
    suspended: billing.suspended as boolean,
  };
}

export function isUserBillingUnavailable(
  billing: AdminUserBillingViewV1,
): billing is AdminUserBillingUnavailableV1 {
  return "unavailable" in billing;
}

export function decodeAdminUserBillingViewV1(
  input: unknown,
): AdminUserBillingViewV1 {
  const billing = record(input, "admin user billing");
  if ("unavailable" in billing) {
    exactKeys(billing, ["unavailable"], "admin user billing");
    if (billing.unavailable !== true) {
      throw new Error("admin user billing.unavailable is invalid");
    }
    return { unavailable: true };
  }
  return decodeAdminUserBillingV1(billing);
}

export function decodeGrantUserCreditCommandV1(
  input: unknown,
): GrantUserCreditCommandV1 {
  const command = record(input, "credit grant command");
  exactKeys(
    command,
    ["schemaVersion", "type", "id", "cents", "reason"],
    "credit grant command",
  );
  if (command.schemaVersion !== 1 || command.type !== "user/grant-credit") {
    throw new Error("credit grant command is invalid");
  }
  const id = boundedString(command.id, "credit grant command.id", 128);
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    throw new Error("credit grant command.id is invalid");
  }
  if (
    !Number.isSafeInteger(command.cents) ||
    (command.cents as number) < 1 ||
    (command.cents as number) > GRANT_USER_CREDIT_MAXIMUM_CENTS
  ) {
    throw new Error("credit grant command.cents is invalid");
  }
  return {
    schemaVersion: 1,
    type: "user/grant-credit",
    id,
    cents: command.cents as number,
    reason: boundedString(command.reason, "credit grant command.reason", 300),
  };
}

export function decodeGrantUserCreditRequestV1(
  input: unknown,
): GrantUserCreditRequestV1 {
  const request = record(input, "credit grant request");
  exactKeys(
    request,
    ["schemaVersion", "userId", "command", "grantedBy"],
    "credit grant request",
  );
  if (request.schemaVersion !== 1) {
    throw new Error("credit grant request.schemaVersion is invalid");
  }
  return {
    schemaVersion: 1,
    userId: boundedString(request.userId, "credit grant request.userId", 512),
    command: decodeGrantUserCreditCommandV1(request.command),
    grantedBy: boundedString(
      request.grantedBy,
      "credit grant request.grantedBy",
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
  const allowed = ["userId", "email", "name", "features", "billing"];
  if (!keys.every((key) => allowed.includes(key))) {
    throw new Error("admin user has unknown fields");
  }
  const email = optionalDisplayString(user.email, 512);
  const name = optionalDisplayString(user.name, 512);
  return {
    userId: boundedString(user.userId, "admin user.userId", 512),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    features: decodeAdminUserFeaturesV1(user.features),
    billing: decodeAdminUserBillingViewV1(user.billing),
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
