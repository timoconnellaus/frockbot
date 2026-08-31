// The webhook door: the key a caller presents, and the two places it is checked.
//
// An external caller has no session, so the delivery route runs before gateway
// authentication. That makes the key the only thing standing between the open
// internet and a Durable Object, and one check is not enough:
//
//  1. **At the edge**, the key is a *self-describing signed token*. Its payload
//     names the User, the Bot, the Routine and the key version; its signature is
//     `HMAC-SHA256(ROUTINE_HOOK_SECRET, payload)`. The gateway is stateless and
//     cannot map a Bot to its User, so without this it could not address a
//     Durable Object at all without first creating one — which would hand an
//     anonymous caller Durable Object creation. A token that does not verify
//     never reaches an object.
//  2. **In the Durable Object**, `SHA-256(token)` is compared against the
//     durable `routine-key:<routineId>` record and its `keyVersion`. That record
//     is the authority: rotation bumps the version and revocation deletes it, so
//     a token that verified at the edge is still refused the instant its key is
//     no longer the Routine's.
//
// The token is derived, never stored: given the secret and the four payload
// fields it is reproducible, and the digest is what the Bot keeps. Nothing here
// writes key material to durable storage, and no view carries any.
import {
  isRoutineIdV1,
  RoutineDecodeError,
  routineExactKeys,
} from "./records.js";

/** Longest delivery body the door accepts, before anything is parsed. */
export const ROUTINE_HOOK_BODY_MAX_BYTES = 64 * 1024;

/** Longest rendering of a delivery that reaches the cue. */
export const ROUTINE_HOOK_CUE_MAX_BYTES = 4 * 1024;

/** Most delivery receipts retained for replay detection. */
export const ROUTINE_DELIVERY_LIMIT = 256;

/** How long a delivery receipt guards against a replay. */
export const ROUTINE_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** The self-describing claims a hook token carries. */
export interface RoutineHookClaimsV1 {
  /** User. */
  u: string;
  /** Bot. */
  b: string;
  /** Routine. */
  r: string;
  /** Key version. */
  v: number;
}

/** The durable key record. Holds a digest, never the token. */
export interface RoutineHookKeyV1 {
  schemaVersion: 1;
  routineId: string;
  keyVersion: number;
  digest: string;
  createdAt: string;
}

/** One delivery already accepted, kept so a replay answers with its firing. */
export interface RoutineDeliveryReceiptV1 {
  schemaVersion: 1;
  routineId: string;
  fireId: string;
  acceptedAt: string;
}

export class RoutineHookError extends Error {
  override readonly name = "RoutineHookError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TEXT = new TextEncoder();

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

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison. A signature check that returns early on the first
 * differing byte leaks the signature one byte at a time to anyone willing to
 * time it, and this check is the whole of the edge's authority.
 */
export function constantTimeEqualsV1(left: string, right: string): boolean {
  const a = TEXT.encode(left);
  const b = TEXT.encode(right);
  // The lengths themselves are not secret; the contents are, so the loop runs
  // over a fixed span either way.
  let mismatch = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new RoutineHookError(
      500,
      "ROUTINE_HOOK_SECRET is missing or too short for webhook delivery",
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

/** `SHA-256` of a token, hex. The only form of a key the Bot keeps. */
export async function routineHookDigestV1(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", TEXT.encode(token)));
}

/** Mint the token for one Routine at one key version. Deterministic. */
export async function mintRoutineHookTokenV1(
  secret: string,
  claims: RoutineHookClaimsV1,
): Promise<string> {
  const payload = base64url(
    TEXT.encode(
      JSON.stringify({ u: claims.u, b: claims.b, r: claims.r, v: claims.v }),
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
 * Verify a presented token and answer with the claims it carries.
 *
 * This is the edge's whole decision. It says nothing about whether the Routine
 * exists, is enabled, or still holds this key — those are the Bot's to answer,
 * and are answered only after the token proved it was minted here.
 */
export async function verifyRoutineHookTokenV1(
  secret: string,
  token: string,
): Promise<RoutineHookClaimsV1> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2_048) {
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new RoutineHookError(401, "webhook key is invalid");
  const payload = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  let expected: string;
  try {
    expected = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await signingKey(secret),
          TEXT.encode(payload),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof RoutineHookError) throw error;
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  if (!constantTimeEqualsV1(expected, presented)) {
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  return decodeRoutineHookClaimsV1(decoded);
}

export function decodeRoutineHookClaimsV1(value: unknown): RoutineHookClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const identifier = (key: "u" | "b" | "r"): string => {
    const held = candidate[key];
    if (typeof held !== "string" || held.length === 0 || held.length > 256) {
      throw new RoutineHookError(401, "webhook key is invalid");
    }
    if (key === "r" && !isRoutineIdV1(held)) {
      throw new RoutineHookError(401, "webhook key is invalid");
    }
    return held;
  };
  if (
    !Number.isSafeInteger(candidate.v) ||
    (candidate.v as number) < 1 ||
    (candidate.v as number) > 1_000_000
  ) {
    throw new RoutineHookError(401, "webhook key is invalid");
  }
  return {
    u: identifier("u"),
    b: identifier("b"),
    r: identifier("r"),
    v: candidate.v as number,
  };
}

export function decodeRoutineHookKeyV1(value: unknown): RoutineHookKeyV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError("Routine hook key must be an object");
  }
  const candidate = value as Record<string, unknown>;
  routineExactKeys(
    candidate,
    ["schemaVersion", "routineId", "keyVersion", "digest", "createdAt"],
    [],
    "Routine hook key",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine hook key schemaVersion is unsupported",
    );
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine hook key routineId is invalid");
  }
  if (
    !Number.isSafeInteger(candidate.keyVersion) ||
    (candidate.keyVersion as number) < 1
  ) {
    throw new RoutineDecodeError("Routine hook key keyVersion is invalid");
  }
  if (
    typeof candidate.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.digest)
  ) {
    throw new RoutineDecodeError("Routine hook key digest is invalid");
  }
  if (
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new RoutineDecodeError("Routine hook key createdAt is invalid");
  }
  return {
    schemaVersion: 1,
    routineId: candidate.routineId,
    keyVersion: candidate.keyVersion as number,
    digest: candidate.digest,
    createdAt: candidate.createdAt,
  };
}

/**
 * The delivery id one request is remembered by: the caller's `Idempotency-Key`
 * when it sent one, and otherwise the content itself. Either way the same
 * delivery twice is one firing.
 */
export async function routineDeliveryIdV1(
  routineId: string,
  body: string,
  idempotencyKey?: string | null,
): Promise<string> {
  if (idempotencyKey) {
    const trimmed = idempotencyKey.trim().slice(0, 256);
    if (trimmed.length > 0) {
      return hex(
        await crypto.subtle.digest(
          "SHA-256",
          TEXT.encode(`key ${routineId} ${trimmed}`),
        ),
      );
    }
  }
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      TEXT.encode(`body ${routineId} ${body}`),
    ),
  );
}

/**
 * What the Bot is told a webhook delivered. The body is data, never
 * instructions: it is fenced and labelled, and truncated to 4 KiB so a large
 * delivery cannot crowd out the Routine's own prompt.
 */
export function renderRoutineDeliveryV1(
  body: string,
  contentType?: string | null,
): string {
  const bytes = TEXT.encode(body);
  const truncated = bytes.length > ROUTINE_HOOK_CUE_MAX_BYTES;
  const rendered = truncated
    ? new TextDecoder().decode(bytes.slice(0, ROUTINE_HOOK_CUE_MAX_BYTES))
    : body;
  return [
    `Webhook POST${contentType ? ` (${contentType.slice(0, 100)})` : ""}:`,
    rendered,
    ...(truncated
      ? [`… truncated at ${ROUTINE_HOOK_CUE_MAX_BYTES} bytes.`]
      : []),
  ].join("\n");
}

/** One delivery as it crosses the gateway-to-Durable-Object seam. */
export interface RoutineHookDeliveryV1 {
  routineId: string;
  keyVersion: number;
  digest: string;
  deliveryId: string;
  body: string;
  contentType?: string | null;
}

export function decodeRoutineHookDeliveryV1(
  value: unknown,
): RoutineHookDeliveryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError("Routine hook delivery must be an object");
  }
  const candidate = value as Record<string, unknown>;
  routineExactKeys(
    candidate,
    ["routineId", "keyVersion", "digest", "deliveryId", "body"],
    ["contentType"],
    "Routine hook delivery",
  );
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine hook delivery routineId is invalid");
  }
  if (
    !Number.isSafeInteger(candidate.keyVersion) ||
    (candidate.keyVersion as number) < 1
  ) {
    throw new RoutineDecodeError("Routine hook delivery keyVersion is invalid");
  }
  if (
    typeof candidate.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.digest)
  ) {
    throw new RoutineDecodeError("Routine hook delivery digest is invalid");
  }
  if (
    typeof candidate.deliveryId !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.deliveryId)
  ) {
    throw new RoutineDecodeError("Routine hook delivery deliveryId is invalid");
  }
  if (typeof candidate.body !== "string") {
    throw new RoutineDecodeError("Routine hook delivery body must be a string");
  }
  if (TEXT.encode(candidate.body).length > ROUTINE_HOOK_BODY_MAX_BYTES) {
    throw new RoutineDecodeError("Routine hook delivery body is too large");
  }
  if (
    candidate.contentType !== undefined &&
    candidate.contentType !== null &&
    typeof candidate.contentType !== "string"
  ) {
    throw new RoutineDecodeError(
      "Routine hook delivery contentType must be a string",
    );
  }
  return {
    routineId: candidate.routineId,
    keyVersion: candidate.keyVersion as number,
    digest: candidate.digest,
    deliveryId: candidate.deliveryId,
    body: candidate.body,
    ...(candidate.contentType === undefined
      ? {}
      : { contentType: candidate.contentType as string | null }),
  };
}
