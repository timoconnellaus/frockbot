// The pairing code: the one secret a browser ever holds for a machine.
//
// A device agent that has never enrolled has no token, so the code is the only
// thing it can present — and `POST /api/machines/enroll` runs *before* gateway
// authentication, because a program on somebody's laptop has no session. That
// puts the code in exactly the position `plugin-routines`' webhook key is in:
// the gateway is stateless and cannot map a machine to its User, so a code that
// did not name one would force an anonymous caller to decide which Durable
// Object gets created. So the code is a signed token, not a random string:
//
//   base64url(userId) "." machineId "." nonce "." truncated-HMAC
//
// The signature is checked at the edge, in constant time, before any object is
// addressed; the User Durable Object then checks the code's digest against the
// unspent pairing record it holds, which is what makes the code *one-time* and
// what expires it after five minutes. Neither check is sufficient alone: the
// signature proves only that this deployment minted the code, and the record
// proves only that some code was minted for this machine.
//
// The code is derived and never stored, exactly as the machine token is: the
// backend keeps `SHA-256(code)` and nothing else.

import {
  constantTimeEqualsV1,
  MACHINE_LIMITS_V1,
  MachineTokenError,
} from "@frockbot/machine-protocol";

/** What a verified pairing code names. */
export interface MachinePairingClaimsV1 {
  userId: string;
  machineId: string;
  nonce: string;
}

/** The one thing a failed verify ever says. Which half failed is not the caller's. */
const INVALID = "machine pairing code is invalid";

const TEXT = new TextEncoder();

/**
 * 128 bits of tag and 96 bits of nonce.
 *
 * The full `HMAC-SHA256` output would be 43 base64url characters and the code
 * has a length ceiling it must live inside — `MACHINE_LIMITS_V1.pairingCode` —
 * which the User claim already spends most of. A 128-bit tag is the standard
 * truncation and is not the code's only defence: the code is single-use, dies
 * in five minutes, and is checked against a stored digest.
 */
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

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

async function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new MachineTokenError(
      500,
      "MACHINE_TOKEN_SECRET is missing or too short to mint a pairing code",
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

async function tag(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    TEXT.encode(payload),
  );
  return base64url(new Uint8Array(signature).slice(0, TAG_BYTES));
}

/** A fresh, unpredictable nonce. One per mint, so no two codes are the same. */
export function machinePairingNonceV1(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/** `SHA-256` of a code, hex. The only form of a code the backend keeps. */
export async function machinePairingCodeDigestV1(
  code: string,
): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", TEXT.encode(code)));
}

/**
 * Mint one pairing code. Deterministic given the nonce, so a test can mint the
 * exact code it is about to present and a forged one it must be refused.
 */
export async function mintMachinePairingCodeV1(
  secret: string,
  claims: MachinePairingClaimsV1,
): Promise<string> {
  const payload = `${base64url(TEXT.encode(claims.userId))}.${claims.machineId}.${claims.nonce}`;
  const code = `${payload}.${await tag(secret, payload)}`;
  if (code.length > MACHINE_LIMITS_V1.pairingCode) {
    // Refused rather than truncated: a code the enrollment decoder would
    // refuse is a pairing that fails at the machine instead of here, with
    // nothing to say why.
    throw new MachineTokenError(
      500,
      "machine pairing code exceeds its length bound for this account",
    );
  }
  return code;
}

/**
 * Verify a presented code and answer with the claims it carries.
 *
 * This is the edge's whole decision. Whether the code has been spent, has
 * expired, or was ever minted for this machine is the User Durable Object's to
 * answer against the pairing record it holds — and it is asked only after the
 * code proved it was minted here.
 */
export async function verifyMachinePairingCodeV1(
  secret: string,
  code: string,
): Promise<MachinePairingClaimsV1> {
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    code.length > MACHINE_LIMITS_V1.pairingCode
  ) {
    throw new MachineTokenError(401, INVALID);
  }
  const separator = code.lastIndexOf(".");
  if (separator <= 0) throw new MachineTokenError(401, INVALID);
  const payload = code.slice(0, separator);
  const presented = code.slice(separator + 1);
  let expected: string;
  try {
    expected = await tag(secret, payload);
  } catch (error) {
    if (error instanceof MachineTokenError) throw error;
    throw new MachineTokenError(401, INVALID);
  }
  if (!constantTimeEqualsV1(expected, presented)) {
    throw new MachineTokenError(401, INVALID);
  }
  const parts = payload.split(".");
  if (parts.length !== 3) throw new MachineTokenError(401, INVALID);
  let userId: string;
  try {
    userId = new TextDecoder().decode(fromBase64url(parts[0]!));
  } catch {
    throw new MachineTokenError(401, INVALID);
  }
  if (userId.length === 0 || userId.length > 256) {
    throw new MachineTokenError(401, INVALID);
  }
  return { userId, machineId: parts[1]!, nonce: parts[2]! };
}
