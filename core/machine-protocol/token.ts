// The machine door: the key an agent presents, and the two places it is checked.
//
// A device agent has no session — it is a program on the User's laptop, not a
// browser — so `poll`, `claim` and `result` run before gateway authentication.
// That makes the token the only thing standing between the open internet and a
// Durable Object, and one check is not enough. This is `plugin-routines`'
// webhook door, port for port:
//
//  1. **At the edge**, the token is a *self-describing signed token*. Its
//     payload names the User, the machine and the key version; its signature is
//     `HMAC-SHA256(MACHINE_TOKEN_SECRET, payload)`. The gateway is stateless
//     and cannot map a machine to its User, so without the claims it could not
//     address a Durable Object at all without first creating one — which would
//     hand an anonymous caller Durable Object creation. A token that does not
//     verify never reaches an object.
//  2. **In the User Durable Object**, `SHA-256(token)` is compared against the
//     `tokenDigest` on the machine record, together with its `keyVersion`. That
//     record is the authority: revocation bumps the version and sets
//     `revokedAt`, so a token that verified at the edge is still refused the
//     instant it is no longer the machine's.
//
// The token is derived, never stored: given the secret and the three payload
// fields it is reproducible, and the digest is all the backend keeps. Nothing
// here writes key material to durable storage, and no view carries any.

import { decodeMachineIdV1 } from "./protocol.js";

/** The self-describing claims a machine token carries. */
export interface MachineTokenClaimsV1 {
  /** User. */
  u: string;
  /** Machine. */
  m: string;
  /** Key version. */
  v: number;
}

export class MachineTokenError extends Error {
  override readonly name = "MachineTokenError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The one thing a failed verify ever says. Which half failed is not the caller's. */
const INVALID = "machine token is invalid";

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
    throw new MachineTokenError(
      500,
      "MACHINE_TOKEN_SECRET is missing or too short for machine enrollment",
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

/** `SHA-256` of a token, hex. The only form of a key the backend keeps. */
export async function machineTokenDigestV1(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", TEXT.encode(token)));
}

/** Mint the token for one machine at one key version. Deterministic. */
export async function mintMachineTokenV1(
  secret: string,
  claims: MachineTokenClaimsV1,
): Promise<string> {
  const payload = base64url(
    TEXT.encode(JSON.stringify({ u: claims.u, m: claims.m, v: claims.v })),
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
 * This is the edge's whole decision. It says nothing about whether the machine
 * exists, is revoked, or still holds this key version — those are the User
 * Durable Object's to answer against `tokenDigest`, and are answered only after
 * the token proved it was minted here.
 */
export async function verifyMachineTokenV1(
  secret: string,
  token: string,
): Promise<MachineTokenClaimsV1> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2_048) {
    throw new MachineTokenError(401, INVALID);
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new MachineTokenError(401, INVALID);
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
    if (error instanceof MachineTokenError) throw error;
    throw new MachineTokenError(401, INVALID);
  }
  if (!constantTimeEqualsV1(expected, presented)) {
    throw new MachineTokenError(401, INVALID);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    throw new MachineTokenError(401, INVALID);
  }
  return machineTokenClaimsV1(decoded);
}

/** Decode the claims half of a token. Exact-key, like every other seam. */
export function machineTokenClaimsV1(value: unknown): MachineTokenClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MachineTokenError(401, INVALID);
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== "u" && key !== "m" && key !== "v") {
      throw new MachineTokenError(401, INVALID);
    }
  }
  const held = candidate.u;
  if (typeof held !== "string" || held.length === 0 || held.length > 256) {
    throw new MachineTokenError(401, INVALID);
  }
  let machineId: string;
  try {
    machineId = decodeMachineIdV1(candidate.m, "machine token m");
  } catch {
    throw new MachineTokenError(401, INVALID);
  }
  if (
    !Number.isSafeInteger(candidate.v) ||
    (candidate.v as number) < 1 ||
    (candidate.v as number) > 1_000_000
  ) {
    throw new MachineTokenError(401, INVALID);
  }
  return { u: held, m: machineId, v: candidate.v as number };
}

/**
 * The second check, expressed once so the Durable Object and its tests cannot
 * drift: the presented token's digest must be the record's, at the record's
 * current key version, and the record must not be revoked. Answering `false`
 * rather than throwing keeps the caller free to choose 401 or 403.
 */
export function machineTokenMatchesRecordV1(
  record: { keyVersion: number; tokenDigest: string; revokedAt?: string },
  claims: MachineTokenClaimsV1,
  presentedDigest: string,
): boolean {
  if (record.revokedAt !== undefined) return false;
  if (record.keyVersion !== claims.v) return false;
  return constantTimeEqualsV1(record.tokenDigest, presentedDigest);
}

/** The scheme a machine presents its token under, at every machine route. */
export const MACHINE_AUTHORIZATION_SCHEME = "Bearer";

/**
 * The token out of an `Authorization` header, or `undefined`. Parsing lives in
 * the protocol so the gateway, the desktop agent and the stub agent all agree
 * on what a presented token looks like before anyone tries to verify one.
 */
export function machineBearerTokenV1(
  header: string | null | undefined,
): string | undefined {
  if (typeof header !== "string") return undefined;
  const prefix = `${MACHINE_AUTHORIZATION_SCHEME} `;
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? undefined : token;
}
