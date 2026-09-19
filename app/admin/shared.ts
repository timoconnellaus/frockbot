// --- Beta access --------------------------------------------------------------
//
// Who may use this deployment. The deployment's admission mode decides only
// whether an account with no access record may be *given* one; an account's
// own record decides everything else. Signing in proves an identity, and a
// provisioned User proves nothing: neither is access.

/**
 * `closed` admits no account that is not already active; `invite-only`
 * activates an invited account; `open` activates any account that has no
 * record. None of them changes an account whose record says otherwise.
 */
export type AdmissionModeV1 = "closed" | "invite-only" | "open";

export const ADMISSION_MODES_V1: readonly AdmissionModeV1[] = [
  "closed",
  "invite-only",
  "open",
];

export interface DeploymentPolicyV1 {
  schemaVersion: 1;
  revision: number;
  admission: { mode: AdmissionModeV1 };
  updatedAt: string;
  updatedBy: string;
}

export interface SetAdmissionModeCommandV1 {
  schemaVersion: 1;
  type: "deployment/set-admission-mode";
  mode: AdmissionModeV1;
  revision: number;
}

export interface SetAdmissionModeRequestV1 {
  schemaVersion: 1;
  command: SetAdmissionModeCommandV1;
  updatedBy: string;
}

/**
 * `invited` may become `active` on its next sign-in unless admission is
 * closed. `paused`, `ended` and `blocked` are only ever set by an admin and
 * only ever left by an admin: admission never moves an account out of them.
 */
export type AccountAccessStateV1 =
  "invited" | "active" | "paused" | "ended" | "blocked";

export const ACCOUNT_ACCESS_STATES_V1: readonly AccountAccessStateV1[] = [
  "invited",
  "active",
  "paused",
  "ended",
  "blocked",
];

export interface AccountAccessV1 {
  schemaVersion: 1;
  userId: string;
  state: AccountAccessStateV1;
  /** Compare-and-swap counter; an account with no record is revision 0. */
  revision: number;
  updatedAt: string;
  /** An admin's User id, or `admission` when sign-in activated the account. */
  updatedBy: string;
}

export interface AccountAccessViewV1 {
  schemaVersion: 1;
  userId: string;
  access: AccountAccessV1 | null;
}

/**
 * What an administrative write answers.
 *
 * A compare-and-swap that lost is an answer, not a failure: someone wrote
 * first, and the revision the next attempt must carry comes back with it. The
 * caller is the admin portal, across a service binding, where an exception is
 * a message and nothing more.
 */
export type AdminWriteResultV1<T> =
  | { status: "applied"; value: T }
  | { status: "conflict"; currentRevision: number };

/** Decode an administrative compare-and-swap answer at the RPC seam. */
export function decodeAdminWriteResultV1<T>(
  input: unknown,
  decodeValue: (value: unknown) => T,
  label: string,
): AdminWriteResultV1<T> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const answer = input as Record<string, unknown>;
  if (answer.status === "conflict") {
    if (!Number.isSafeInteger(answer.currentRevision)) {
      throw new Error(`${label}.currentRevision is invalid`);
    }
    return {
      status: "conflict",
      currentRevision: answer.currentRevision as number,
    };
  }
  if (answer.status !== "applied") {
    throw new Error(`${label}.status is invalid`);
  }
  return { status: "applied", value: decodeValue(answer.value) };
}

export interface SetAccountAccessCommandV1 {
  schemaVersion: 1;
  type: "account/set-access";
  state: AccountAccessStateV1;
  /** The record revision the admin read; 0 when the account had none. */
  revision: number;
}

export interface SetAccountAccessRequestV1 {
  schemaVersion: 1;
  userId: string;
  command: SetAccountAccessCommandV1;
  updatedBy: string;
}

/**
 * An invitation for an identity that may not exist yet. It is redeemed only
 * by a sign-in whose identity provider verified this exact address, so typing
 * someone else's email into a sign-up form grants nothing.
 */
export interface EmailInvitationV1 {
  schemaVersion: 1;
  email: string;
  invitedAt: string;
  invitedBy: string;
}

export interface InviteEmailCommandV1 {
  schemaVersion: 1;
  type: "access/invite-email";
  email: string;
}

export interface InviteEmailRequestV1 {
  schemaVersion: 1;
  command: InviteEmailCommandV1;
  invitedBy: string;
}

/** The identity a sign-in presents, as the gateway resolved it. */
export interface AdmissionIdentityV1 {
  schemaVersion: 1;
  userId: string;
  email?: string;
  emailVerified: boolean;
  /** Derived from the deployment's admin allowlist, never from the client. */
  isAdmin: boolean;
}

/** An identity about to be written by the identity provider, before it has an id. */
export interface IdentityCreationRequestV1 {
  schemaVersion: 1;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
}

export type AdmissionRefusalReasonV1 =
  | "admission-closed"
  | "invitation-required"
  | "account-paused"
  | "account-ended"
  | "account-blocked";

export type AccountAdmissionDecisionV1 =
  | {
      schemaVersion: 1;
      admitted: true;
      basis: "admin" | "active" | "invitation" | "open";
    }
  | { schemaVersion: 1; admitted: false; reason: AdmissionRefusalReasonV1 };

/**
 * What a refused person is told. Each line is true of the reason it names and
 * of nothing else: an unknown account is never told it was invited, and a
 * paused one is never told the deployment is closed.
 */
export const ADMISSION_REFUSAL_COPY_V1: Readonly<
  Record<AdmissionRefusalReasonV1, { title: string; detail: string }>
> = {
  "admission-closed": {
    title: "FrockBot isn't admitting new accounts right now.",
    detail: "You're signed in, but this account doesn't have beta access.",
  },
  "invitation-required": {
    title: "FrockBot is invite-only right now.",
    detail: "You're signed in, but this account doesn't have beta access.",
  },
  "account-paused": {
    title: "Your FrockBot access is paused.",
    detail: "Your account and Bots are kept while access is paused.",
  },
  "account-ended": {
    title: "Your FrockBot beta access has ended.",
    detail: "Thanks for trying FrockBot.",
  },
  "account-blocked": {
    title: "This account can't use FrockBot.",
    detail: "Sign in with a different account to continue.",
  },
};

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

function admissionMode(value: unknown, label: string): AdmissionModeV1 {
  if (!ADMISSION_MODES_V1.includes(value as AdmissionModeV1)) {
    throw new Error(`${label} is invalid`);
  }
  return value as AdmissionModeV1;
}

function accessState(value: unknown, label: string): AccountAccessStateV1 {
  if (!ACCOUNT_ACCESS_STATES_V1.includes(value as AccountAccessStateV1)) {
    throw new Error(`${label} is invalid`);
  }
  return value as AccountAccessStateV1;
}

function envelope(input: unknown, label: string, keys: readonly string[]) {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", ...keys], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  return value;
}

/**
 * The deployment's administrators, as `FROCKBOT_ADMIN_EMAILS` spells them: a
 * comma-separated list, compared trimmed and lower-cased. Both the app (who
 * bypasses admission, who opens the debug surface) and the admin portal (who
 * may administer at all) read the same secret through this one parse.
 */
export function adminEmailsV1(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

/**
 * The one spelling of an email this authority compares. Identity providers
 * treat the local part case-insensitively in practice, and an invitation that
 * missed on case would refuse the person it was written for.
 */
export function normalizeAccessEmailV1(value: unknown, label: string): string {
  const email = boundedString(value, label, 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${label} is invalid`);
  }
  return email;
}

/** A usable address, or none: an identity whose email is malformed claims nothing. */
export function accessEmailV1(value: unknown): string | undefined {
  try {
    return normalizeAccessEmailV1(value, "email");
  } catch {
    return undefined;
  }
}

export function decodeDeploymentPolicyV1(input: unknown): DeploymentPolicyV1 {
  const policy = envelope(input, "deployment policy", [
    "revision",
    "admission",
    "updatedAt",
    "updatedBy",
  ]);
  const admission = record(policy.admission, "deployment policy.admission");
  exactKeys(admission, ["mode"], "deployment policy.admission");
  return {
    schemaVersion: 1,
    revision: revision(policy.revision, "deployment policy.revision"),
    admission: {
      mode: admissionMode(admission.mode, "deployment policy.admission.mode"),
    },
    updatedAt: isoTimestamp(policy.updatedAt, "deployment policy.updatedAt"),
    updatedBy: boundedString(
      policy.updatedBy,
      "deployment policy.updatedBy",
      512,
    ),
  };
}

export function decodeSetAdmissionModeCommandV1(
  input: unknown,
): SetAdmissionModeCommandV1 {
  const command = envelope(input, "admission mode command", [
    "type",
    "mode",
    "revision",
  ]);
  if (command.type !== "deployment/set-admission-mode") {
    throw new Error("admission mode command.type is invalid");
  }
  return {
    schemaVersion: 1,
    type: "deployment/set-admission-mode",
    mode: admissionMode(command.mode, "admission mode command.mode"),
    revision: revision(command.revision, "admission mode command.revision"),
  };
}

export function decodeAccountAccessV1(input: unknown): AccountAccessV1 {
  const access = envelope(input, "account access", [
    "userId",
    "state",
    "revision",
    "updatedAt",
    "updatedBy",
  ]);
  const accessRevision = revision(access.revision, "account access.revision");
  if (accessRevision < 1) throw new Error("account access.revision is invalid");
  return {
    schemaVersion: 1,
    userId: boundedString(access.userId, "account access.userId", 512),
    state: accessState(access.state, "account access.state"),
    revision: accessRevision,
    updatedAt: isoTimestamp(access.updatedAt, "account access.updatedAt"),
    updatedBy: boundedString(access.updatedBy, "account access.updatedBy", 512),
  };
}

export function decodeAccountAccessViewV1(input: unknown): AccountAccessViewV1 {
  const view = envelope(input, "account access view", ["userId", "access"]);
  const userId = boundedString(view.userId, "account access view.userId", 512);
  const access =
    view.access === null ? null : decodeAccountAccessV1(view.access);
  if (access && access.userId !== userId) {
    throw new Error("account access view.access names another account");
  }
  return { schemaVersion: 1, userId, access };
}

export function decodeSetAccountAccessCommandV1(
  input: unknown,
): SetAccountAccessCommandV1 {
  const command = envelope(input, "account access command", [
    "type",
    "state",
    "revision",
  ]);
  if (command.type !== "account/set-access") {
    throw new Error("account access command.type is invalid");
  }
  return {
    schemaVersion: 1,
    type: "account/set-access",
    state: accessState(command.state, "account access command.state"),
    revision: revision(command.revision, "account access command.revision"),
  };
}

export function decodeSetAccountAccessRequestV1(
  input: unknown,
): SetAccountAccessRequestV1 {
  const request = envelope(input, "account access request", [
    "userId",
    "command",
    "updatedBy",
  ]);
  return {
    schemaVersion: 1,
    userId: boundedString(request.userId, "account access request.userId", 512),
    command: decodeSetAccountAccessCommandV1(request.command),
    updatedBy: boundedString(
      request.updatedBy,
      "account access request.updatedBy",
      512,
    ),
  };
}

export function decodeAccountAccessReadRequestV1(input: unknown): {
  schemaVersion: 1;
  userId: string;
} {
  const request = envelope(input, "account access read request", ["userId"]);
  return {
    schemaVersion: 1,
    userId: boundedString(
      request.userId,
      "account access read request.userId",
      512,
    ),
  };
}

export function decodeEmailInvitationV1(input: unknown): EmailInvitationV1 {
  const invitation = envelope(input, "email invitation", [
    "email",
    "invitedAt",
    "invitedBy",
  ]);
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(invitation.email, "email invitation.email"),
    invitedAt: isoTimestamp(invitation.invitedAt, "email invitation.invitedAt"),
    invitedBy: boundedString(
      invitation.invitedBy,
      "email invitation.invitedBy",
      512,
    ),
  };
}

export function decodeInviteEmailCommandV1(
  input: unknown,
): InviteEmailCommandV1 {
  const command = envelope(input, "email invitation command", [
    "type",
    "email",
  ]);
  if (command.type !== "access/invite-email") {
    throw new Error("email invitation command.type is invalid");
  }
  return {
    schemaVersion: 1,
    type: "access/invite-email",
    email: normalizeAccessEmailV1(
      command.email,
      "email invitation command.email",
    ),
  };
}

export function decodeInviteEmailRequestV1(
  input: unknown,
): InviteEmailRequestV1 {
  const request = envelope(input, "email invitation request", [
    "command",
    "invitedBy",
  ]);
  return {
    schemaVersion: 1,
    command: decodeInviteEmailCommandV1(request.command),
    invitedBy: boundedString(
      request.invitedBy,
      "email invitation request.invitedBy",
      512,
    ),
  };
}

export function decodeAdmissionIdentityV1(input: unknown): AdmissionIdentityV1 {
  const identity = record(input, "admission identity");
  exactKeys(
    identity,
    ["schemaVersion", "userId", "emailVerified", "isAdmin"],
    "admission identity",
    ["email"],
  );
  if (
    identity.schemaVersion !== 1 ||
    typeof identity.emailVerified !== "boolean" ||
    typeof identity.isAdmin !== "boolean"
  ) {
    throw new Error("admission identity is invalid");
  }
  return {
    schemaVersion: 1,
    userId: boundedString(identity.userId, "admission identity.userId", 512),
    ...(identity.email === undefined
      ? {}
      : {
          email: normalizeAccessEmailV1(
            identity.email,
            "admission identity.email",
          ),
        }),
    emailVerified: identity.emailVerified,
    isAdmin: identity.isAdmin,
  };
}

export function decodeIdentityCreationRequestV1(
  input: unknown,
): IdentityCreationRequestV1 {
  const request = envelope(input, "identity creation request", [
    "email",
    "emailVerified",
    "isAdmin",
  ]);
  if (
    typeof request.emailVerified !== "boolean" ||
    typeof request.isAdmin !== "boolean"
  ) {
    throw new Error("identity creation request is invalid");
  }
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(
      request.email,
      "identity creation request.email",
    ),
    emailVerified: request.emailVerified,
    isAdmin: request.isAdmin,
  };
}

const REFUSAL_REASONS = Object.keys(
  ADMISSION_REFUSAL_COPY_V1,
) as AdmissionRefusalReasonV1[];

export function decodeAccountAdmissionDecisionV1(
  input: unknown,
): AccountAdmissionDecisionV1 {
  const decision = record(input, "admission decision");
  if (decision.schemaVersion !== 1) {
    throw new Error("admission decision.schemaVersion is invalid");
  }
  if (decision.admitted === true) {
    exactKeys(
      decision,
      ["schemaVersion", "admitted", "basis"],
      "admission decision",
    );
    if (
      !["admin", "active", "invitation", "open"].includes(
        decision.basis as string,
      )
    ) {
      throw new Error("admission decision.basis is invalid");
    }
    return {
      schemaVersion: 1,
      admitted: true,
      basis: decision.basis as "admin" | "active" | "invitation" | "open",
    };
  }
  exactKeys(
    decision,
    ["schemaVersion", "admitted", "reason"],
    "admission decision",
  );
  if (
    decision.admitted !== false ||
    !REFUSAL_REASONS.includes(decision.reason as AdmissionRefusalReasonV1)
  ) {
    throw new Error("admission decision is invalid");
  }
  return {
    schemaVersion: 1,
    admitted: false,
    reason: decision.reason as AdmissionRefusalReasonV1,
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

export function decodeSetAdmissionModeRequestV1(
  input: unknown,
): SetAdmissionModeRequestV1 {
  const request = envelope(input, "admission mode request", [
    "command",
    "updatedBy",
  ]);
  return {
    schemaVersion: 1,
    command: decodeSetAdmissionModeCommandV1(request.command),
    updatedBy: boundedString(
      request.updatedBy,
      "admission mode request.updatedBy",
      512,
    ),
  };
}

/**
 * A compare-and-swap that lost. The Worker adapter translates the RPC
 * conflict result to this error; admin routes match its name and revision.
 */
export class DeploymentPolicyConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`deployment policy revision is ${currentRevision}`);
    this.name = "DeploymentPolicyConflictError";
    this.currentRevision = currentRevision;
  }
}

export class AccountAccessConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`account access revision is ${currentRevision}`);
    this.name = "AccountAccessConflictError";
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

/**
 * An account whose access record could not be read when the list was built.
 * Like unreadable features, it is not "no access": no record is a value the
 * authority holds, and the authority could not be reached.
 */
export interface AdminAccountAccessUnavailableV1 {
  unavailable: true;
}

export type AdminAccountAccessViewV1 =
  AccountAccessViewV1 | AdminAccountAccessUnavailableV1;

/** One admin-gated seeded Plugin, as an administrator is offered it. */
export interface AdminGatedPluginV1 {
  pluginId: string;
  displayName: string;
}

/** One account as the admin list shows it: identity, and what it holds. */
export interface AdminUserViewV1 {
  userId: string;
  email?: string;
  name?: string;
  features: AdminUserFeaturesV1;
  billing: AdminUserBillingViewV1;
  access: AdminAccountAccessViewV1;
}

export interface AdminUserListViewV1 {
  schemaVersion: 1;
  users: AdminUserViewV1[];
  /** The catalog's admin-gated Plugins, which is what may be opened at all. */
  gatedPlugins: AdminGatedPluginV1[];
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

export function isAccountAccessUnavailable(
  access: AdminAccountAccessViewV1,
): access is AdminAccountAccessUnavailableV1 {
  return "unavailable" in access;
}

/** The exact unavailable marker, or one account's whole access view. */
export function decodeAdminAccountAccessViewV1(
  input: unknown,
): AdminAccountAccessViewV1 {
  const access = record(input, "admin account access");
  if ("unavailable" in access) {
    exactKeys(access, ["unavailable"], "admin account access");
    if (access.unavailable !== true) {
      throw new Error("admin account access.unavailable is invalid");
    }
    return { unavailable: true };
  }
  return decodeAccountAccessViewV1(access);
}

export function decodeAdminGatedPluginV1(input: unknown): AdminGatedPluginV1 {
  const plugin = record(input, "admin gated plugin");
  exactKeys(plugin, ["pluginId", "displayName"], "admin gated plugin");
  return {
    pluginId: boundedString(plugin.pluginId, "admin gated plugin.pluginId", 64),
    displayName: boundedString(
      plugin.displayName,
      "admin gated plugin.displayName",
      128,
    ),
  };
}

export function decodeAdminUserViewV1(input: unknown): AdminUserViewV1 {
  const user = record(input, "admin user");
  const keys = Object.keys(user);
  const allowed = ["userId", "email", "name", "features", "billing", "access"];
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
    access: decodeAdminAccountAccessViewV1(user.access),
  };
}

export function decodeAdminUserListViewV1(input: unknown): AdminUserListViewV1 {
  const view = record(input, "admin user list");
  exactKeys(
    view,
    ["schemaVersion", "users", "gatedPlugins"],
    "admin user list",
  );
  if (view.schemaVersion !== 1) {
    throw new Error("admin user list.schemaVersion is invalid");
  }
  if (!Array.isArray(view.users) || view.users.length > 1_000) {
    throw new Error("admin user list.users is invalid");
  }
  if (!Array.isArray(view.gatedPlugins) || view.gatedPlugins.length > 64) {
    throw new Error("admin user list.gatedPlugins is invalid");
  }
  return {
    schemaVersion: 1,
    users: view.users.map((user) => decodeAdminUserViewV1(user)),
    gatedPlugins: view.gatedPlugins.map((plugin) =>
      decodeAdminGatedPluginV1(plugin),
    ),
  };
}
