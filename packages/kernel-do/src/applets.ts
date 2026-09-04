// The durable records and keys of one Applet, on both sides of the seam.
//
// ADR 0022 splits an Applet in two. Its *code* is a Package generation:
// immutable, content-addressed, reverted like every other Package. Its *state*
// is a Durable Object facet the kernel mounts and never reads. This module owns
// everything in between — the records the kernel really is the authority for:
//
//  - the **directory entry**, in the User Durable Object under
//    `applets:entry:<appletId>`, plus the `applets:directory-revision` cursor
//    every Bot's next Composition resolution keys off;
//  - the **generation**, the **current** and **last-known-good** pointers, the
//    **failure** records, and the **mount input**, in the `AppletState`
//    Durable Object;
//  - the **focused Applet** of one Session, in the Bot Durable Object;
//  - the **loader identity** an Applet's server artifact is loaded under, and
//    the **viewer token** an open Applet's page presents.
//
// Everything here is exact-keys decoded and carries `schemaVersion`, because
// these are durable records a later version has to migrate rather than guess
// at. The DTOs shared with the isolate capability and the hosted client live in
// `@frockbot/kernel-contracts/applets`; this module is their durable half.
import {
  decodeAppletDirectoryEntryV1,
  decodeAppletGenerationV1,
  type AppletDirectoryEntryV1,
  type AppletGenerationV1,
  type AppletToolDeclarationV1,
  APPLET_ID_V1,
} from "@frockbot/kernel-contracts";

export type {
  AppletDirectoryEntryV1,
  AppletGenerationV1,
  AppletToolDeclarationV1,
};
export { decodeAppletDirectoryEntryV1, decodeAppletGenerationV1 };

// --- durable keys ---------------------------------------------------------

/** User Durable Object: one Applet's directory entry. */
export const APPLET_DIRECTORY_ENTRY_PREFIX = "applets:entry:";
/**
 * User Durable Object: the monotonic cursor a publish, revert, create or
 * delete advances. A Bot's next Composition resolution compares the revision
 * it last resolved against this one, so a directory change reaches every Bot
 * of the User without the User Durable Object knowing which Bots exist.
 */
export const APPLET_DIRECTORY_REVISION_KEY = "applets:directory-revision";

/** Applet Durable Object: one recorded generation. */
export const APPLET_GENERATION_PREFIX = "applet:generation:";
/** Applet Durable Object: the generation currently mounted, if any. */
export const APPLET_CURRENT_KEY = "applet:current";
/** Applet Durable Object: the last generation whose health check passed. */
export const APPLET_LAST_KNOWN_GOOD_KEY = "applet:last-known-good";
/** Applet Durable Object: `applet:failure:<generationId>:<attempt>`. */
export const APPLET_FAILURE_PREFIX = "applet:failure:";
/**
 * Applet Durable Object: the durable mount input.
 *
 * The facet cannot set an alarm (`docs/research/spike-applet-facets.md` §5b),
 * so the kernel object holds it — and its `alarm()` handler may run after an
 * eviction that lost every in-memory field. The input it needs to remount the
 * current generation is therefore written on the synchronous key/value surface
 * at mount time.
 */
export const APPLET_MOUNT_INPUT_KEY = "applet:mount-input";
/**
 * Applet Durable Object: the open activation trial, if one is in flight.
 *
 * An activation is a commit boundary the kernel owns, not a mount the candidate
 * is trusted to survive (ADR 0038). While this key exists the facet's storage is
 * provisional: a byte copy of it is parked in the rollback facet, and whatever
 * reads the Applet next either finds the trial committed — the key deleted — or
 * rolls it back before answering. That is what makes an interrupted publish
 * recoverable rather than half-migrated.
 */
export const APPLET_TRIAL_KEY = "applet:trial";
/** Bot Durable Object: the Session's focused Applet. */
export const APPLET_FOCUSED_KEY = "applets:focused";

/** Attempts are zero-padded so a prefix listing is attempt-ordered. */
export const APPLET_FAILURE_ATTEMPT_DIGITS = 4;
/** The one facet name the kernel mounts under an `AppletState` object. */
export const APPLET_FACET_NAME_V1 = "applet";
/**
 * The second facet name an `AppletState` object uses, and it holds no code.
 *
 * The Durable Object facet API can clone a facet's whole storage, so the kernel
 * parks a byte copy of the live Applet here for the length of one activation
 * trial and clones it back if the candidate fails. Nothing is ever mounted
 * against it; it exists only to be copied from. `AppletState` is the one place
 * that call is made, and an architecture check keeps it that way.
 */
export const APPLET_ROLLBACK_FACET_NAME_V1 = "applet-rollback";
/** The Instance Contract version this kernel speaks. */
export const APPLET_CONTRACT_V1 = 1;
/** Most generations one Applet retains before the oldest are pruned. */
export const APPLET_MAX_GENERATIONS_V1 = 64;
/** Most Applets one User may hold. Quotas proper are deferred (ADR 0022). */
export const APPLET_MAX_PER_USER_V1 = 64;

/**
 * The Applets Package's declared durable root, where an Applet's source and
 * built `dist/` live on the Computer.
 *
 * TODO(lane C1): import `APPLETS_PACKAGE_ID_V1` / `APPLETS_SOURCE_ROOT_ID_V1`
 * from `@frockbot/plugin-applets/root` once that lane lands. They are declared
 * here for now because the kernel imports no Package — the constants are two
 * strings the manifest also declares, and the architecture check that the
 * kernel names no Package keeps them from becoming an import.
 */
export const APPLETS_PACKAGE_ID_V1 = "applets";
export const APPLETS_SOURCE_ROOT_ID_V1 = "source";

export function appletDirectoryEntryKey(appletId: string): string {
  return `${APPLET_DIRECTORY_ENTRY_PREFIX}${appletId}`;
}

export function appletGenerationKey(generationId: string): string {
  return `${APPLET_GENERATION_PREFIX}${generationId}`;
}

export function appletFailurePrefix(generationId: string): string {
  return `${APPLET_FAILURE_PREFIX}${generationId}:`;
}

export function appletFailureKey(
  generationId: string,
  attempt: number,
): string {
  return `${appletFailurePrefix(generationId)}${String(attempt).padStart(
    APPLET_FAILURE_ATTEMPT_DIGITS,
    "0",
  )}`;
}

/** The `idFromName` an Applet's Durable Object is addressed by. */
export function appletStateNameV1(userId: string, appletId: string): string {
  if (!userId || userId.includes(":")) {
    throw new Error("Applet state name requires a colon-free user id");
  }
  if (!APPLET_ID_V1.test(appletId)) {
    throw new Error("Applet state name requires a valid applet id");
  }
  return `${userId}:${appletId}`;
}

// --- records --------------------------------------------------------------

/** Which generation an `AppletState` object points at, and since when. */
export interface AppletPointerV1 {
  schemaVersion: 1;
  generationId: string;
  changedAt: string;
}

export type AppletFailurePhaseV1 = "resolve" | "mount" | "health";

/**
 * Why one generation failed to activate. Durable, visible, and never deleted:
 * it is the repair history a User reads, and the constitution's "failures are
 * observable through durable state".
 */
export interface AppletFailureV1 {
  schemaVersion: 1;
  appletId: string;
  generationId: string;
  attempt: number;
  phase: AppletFailurePhaseV1;
  message: string;
  diagnostics: string[];
  recordedAt: string;
}

/**
 * Everything `AppletState` needs to remount the current generation with no
 * other durable read — the alarm handler's whole input after an eviction.
 */
export interface AppletMountInputV1 {
  schemaVersion: 1;
  userId: string;
  appletId: string;
  generationId: string;
  loaderId: string;
  serverHash: string;
  contract: 1;
}

/**
 * One activation in flight: which generation is being tried over the Applet's
 * live storage, and which one the rollback facet holds the storage of.
 *
 * `previous` is absent for an Applet's first generation, where there is no data
 * to protect and a failure discards the candidate's storage instead of
 * restoring anything.
 */
export interface AppletTrialV1 {
  schemaVersion: 1;
  candidate: AppletMountInputV1;
  previous?: AppletMountInputV1;
}

/** One Session's focused Applet. `null` closes the canvas. */
export interface FocusedAppletV1 {
  schemaVersion: 1;
  appletId: string | null;
  changedAt: string;
}

/** The health answer an Applet's facet must give before it is activated. */
export interface AppletHealthV1 {
  contract: 1;
  tools: string[];
  schemaRevision: number;
}

// --- decoders -------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function hashString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha-256 hex digest`);
  }
  return value;
}

function appletId(value: unknown, label: string): string {
  const id = boundedString(value, label, 129);
  if (!APPLET_ID_V1.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

export function decodeAppletPointerV1(
  input: unknown,
  label = "Applet pointer",
): AppletPointerV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "generationId", "changedAt"], [], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: 1,
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      128,
    ),
    changedAt: timestamp(value.changedAt, `${label}.changedAt`),
  };
}

export function decodeAppletFailureV1(
  input: unknown,
  label = "Applet failure",
): AppletFailureV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "appletId",
      "generationId",
      "attempt",
      "phase",
      "message",
      "diagnostics",
      "recordedAt",
    ],
    [],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (
    value.phase !== "resolve" &&
    value.phase !== "mount" &&
    value.phase !== "health"
  ) {
    throw new Error(`${label}.phase is invalid`);
  }
  if (
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 9_999
  ) {
    throw new Error(`${label}.attempt must be a bounded attempt number`);
  }
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 64) {
    throw new Error(`${label}.diagnostics must be a bounded array`);
  }
  return {
    schemaVersion: 1,
    appletId: appletId(value.appletId, `${label}.appletId`),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      128,
    ),
    attempt: value.attempt as number,
    phase: value.phase,
    message: boundedString(value.message, `${label}.message`, 2_048),
    diagnostics: value.diagnostics.map((entry, index) =>
      boundedString(entry, `${label}.diagnostics[${index}]`, 8_192),
    ),
    recordedAt: timestamp(value.recordedAt, `${label}.recordedAt`),
  };
}

export function decodeAppletMountInputV1(
  input: unknown,
  label = "Applet mount input",
): AppletMountInputV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "userId",
      "appletId",
      "generationId",
      "loaderId",
      "serverHash",
      "contract",
    ],
    [],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.contract !== 1) throw new Error(`${label}.contract is unsupported`);
  return {
    schemaVersion: 1,
    userId: boundedString(value.userId, `${label}.userId`, 256),
    appletId: appletId(value.appletId, `${label}.appletId`),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      128,
    ),
    loaderId: hashString(value.loaderId, `${label}.loaderId`),
    serverHash: hashString(value.serverHash, `${label}.serverHash`),
    contract: 1,
  };
}

export function decodeAppletTrialV1(
  input: unknown,
  label = "Applet trial",
): AppletTrialV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "candidate"], ["previous"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: 1,
    candidate: decodeAppletMountInputV1(value.candidate, `${label}.candidate`),
    ...(value.previous === undefined
      ? {}
      : {
          previous: decodeAppletMountInputV1(
            value.previous,
            `${label}.previous`,
          ),
        }),
  };
}

export function decodeFocusedAppletV1(
  input: unknown,
  label = "focused Applet",
): FocusedAppletV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "appletId", "changedAt"], [], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  return {
    schemaVersion: 1,
    appletId:
      value.appletId === null
        ? null
        : appletId(value.appletId, `${label}.appletId`),
    changedAt: timestamp(value.changedAt, `${label}.changedAt`),
  };
}

/**
 * The health contract of an Instance Contribution, mirrored on
 * `BotIsolateContributionHost`: an Applet that will not say what it exposes
 * does not activate.
 */
export function decodeAppletHealthV1(
  input: unknown,
  label = "Applet health",
): AppletHealthV1 {
  const value = record(input, label);
  exactKeys(value, ["contract", "tools", "schemaRevision"], [], label);
  if (value.contract !== 1) throw new Error(`${label}.contract is unsupported`);
  if (!Array.isArray(value.tools) || value.tools.length > 64) {
    throw new Error(`${label}.tools must be a bounded array`);
  }
  if (
    !Number.isSafeInteger(value.schemaRevision) ||
    (value.schemaRevision as number) < 0
  ) {
    throw new Error(`${label}.schemaRevision must be a non-negative integer`);
  }
  const tools = value.tools.map((name, index) =>
    boundedString(name, `${label}.tools[${index}]`, 64),
  );
  if (new Set(tools).size !== tools.length) {
    throw new Error(`${label}.tools contains duplicate names`);
  }
  return { contract: 1, tools, schemaRevision: value.schemaRevision as number };
}

// --- identity -------------------------------------------------------------

const TEXT = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", TEXT.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const APPLET_SECRET_V1 = /^[0-9a-f]{32}$/;
// A User id as the auth layer mints it: mixed case, underscore allowed. Must
// agree with `APPLET_ID_V1`'s owner half.
const APPLET_OWNER_V1 = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

/**
 * `<publicUserId>.<random>` — ADR 0015's share-id shape, reused.
 *
 * The owner half routes: an Applet id names the one User Durable Object and the
 * one `AppletState` object that can answer for it, with no global index. The
 * random half keeps an id from being guessable from its owner alone, which
 * matters the moment a viewer token names an Applet.
 */
export function appletIdV1(ownerId: string, secret: string): string {
  if (!APPLET_OWNER_V1.test(ownerId)) {
    throw new Error("Applet owner id is invalid");
  }
  if (!APPLET_SECRET_V1.test(secret)) {
    throw new Error("Applet secret is invalid");
  }
  return `${ownerId}.${secret}`;
}

/** Mints a fresh Applet id for one owner. */
export function newAppletIdV1(ownerId: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return appletIdV1(
    ownerId,
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

/**
 * The content address of the authority baked into an Applet facet's `env`.
 *
 * `isolateBindingDigestV1`'s inputs for the *User*, because an Applet is
 * account-wide and holds no Bot: the User, the capability surface version, and
 * the Instance Contract. A change to any of them must produce a new isolate,
 * because a loader id serves the `env` it was first loaded with.
 */
export function appletBindingDigestV1(input: {
  userId: string;
  capabilities: readonly string[];
  contract: number;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      userId: input.userId,
      capabilities: [...input.capabilities].sort(),
      contract: input.contract,
    }),
  );
}

/**
 * The loader id an Applet's server artifact is loaded under.
 *
 * `appletId` is an input, and that is the spike's sharpest finding
 * (`docs/research/spike-applet-facets.md` §7): the loader freezes the first
 * caller's `env` for an id process-wide, so two Applets of one User with
 * byte-identical code would otherwise share one `IDENTITY` and one
 * `CAPABILITIES` stub, and the second Applet's capability calls would land on
 * the first Applet's kernel object.
 */
export function appletLoaderIdV1(input: {
  contract: number;
  appletId: string;
  serverHash: string;
  bindingDigest: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      contract: input.contract,
      appletId: input.appletId,
      serverHash: input.serverHash,
      bindingDigest: input.bindingDigest,
    }),
  );
}

/** Sortable and monotonic within one Applet, like a Composition generation id. */
export function appletGenerationIdV1(
  createdAt: string,
  serverHash: string,
): string {
  return `${createdAt}:${serverHash.slice(0, 16)}`;
}

// --- viewer tokens --------------------------------------------------------

/**
 * The claims a viewer token carries. Short names because the payload is
 * base64url in a query string, and an Applet page opens its socket with it.
 */
export interface AppletViewerClaimsV1 {
  /** User. */
  u: string;
  /** Applet. */
  a: string;
  /** Generation the token was minted against. */
  g: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** Fifteen minutes, per plan §4. */
export const APPLET_VIEWER_TOKEN_TTL_MS = 15 * 60_000;

export class AppletViewerTokenError extends Error {
  override readonly name = "AppletViewerTokenError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The one thing a failed verify says. Which half failed is not the caller's. */
const INVALID_TOKEN = "Applet viewer token is invalid";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Constant-time comparison. A signature check that returns early on the first
 * differing byte leaks the signature to anyone willing to time it.
 */
export function constantTimeEqualsV1(left: string, right: string): boolean {
  const a = TEXT.encode(left);
  const b = TEXT.encode(right);
  let mismatch = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new AppletViewerTokenError(
      500,
      "the Applet viewer token secret is missing or too short",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    TEXT.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * `HMAC-SHA-256(secret, payload)` over `{ userId, appletId, generationId, exp }`,
 * the same pattern the machine door and the Routine webhook use.
 *
 * The Applet's page runs in a cookieless sandboxed iframe and can carry no
 * credential, so this token is the whole of its authority — and it is scoped to
 * exactly one User, one Applet, and one generation, for fifteen minutes.
 */
export async function mintAppletViewerTokenV1(
  secret: string,
  claims: AppletViewerClaimsV1,
): Promise<string> {
  if (!APPLET_ID_V1.test(claims.a)) {
    throw new AppletViewerTokenError(400, "Applet id is invalid");
  }
  const payload = base64url(
    TEXT.encode(
      JSON.stringify({
        u: claims.u,
        a: claims.a,
        g: claims.g,
        exp: claims.exp,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    TEXT.encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Verify a presented token and answer with the claims it carries. Says nothing
 * about whether the Applet still exists or still has that generation mounted —
 * the `AppletState` object answers that, and only after the token proved it was
 * minted here.
 */
export async function verifyAppletViewerTokenV1(
  secret: string,
  token: unknown,
  options: { now?: Date } = {},
): Promise<AppletViewerClaimsV1> {
  if (typeof token !== "string" || token.length === 0 || token.length > 1_024) {
    throw new AppletViewerTokenError(401, INVALID_TOKEN);
  }
  const separator = token.indexOf(".");
  if (separator <= 0) throw new AppletViewerTokenError(401, INVALID_TOKEN);
  const payload = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  const expected = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        TEXT.encode(payload),
      ),
    ),
  );
  if (!constantTimeEqualsV1(presented, expected)) {
    throw new AppletViewerTokenError(401, INVALID_TOKEN);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    throw new AppletViewerTokenError(401, INVALID_TOKEN);
  }
  const value = record(decoded, "Applet viewer claims");
  if (
    typeof value.u !== "string" ||
    typeof value.a !== "string" ||
    typeof value.g !== "string" ||
    !Number.isSafeInteger(value.exp) ||
    !APPLET_ID_V1.test(value.a)
  ) {
    throw new AppletViewerTokenError(401, INVALID_TOKEN);
  }
  const now = options.now ?? new Date();
  if ((value.exp as number) * 1_000 <= now.getTime()) {
    throw new AppletViewerTokenError(401, INVALID_TOKEN);
  }
  return {
    u: value.u,
    a: value.a,
    g: value.g,
    exp: value.exp as number,
  };
}
