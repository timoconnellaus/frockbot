// The external Channel's door key: one signed token per Channel, checked twice.
//
// An external platform has no session with this deployment, so a delivery
// arrives before the gateway has authenticated anything. The token is therefore
// the only thing standing between the open internet and a Durable Object, and
// one check is not enough — the shape is the one `plugin-routines/src/hook.ts`
// already proved:
//
//  1. **At the edge**, the token is a *self-describing signed token*. Its
//     payload names the User, the Channel, the Connection, a per-mint nonce and
//     a key version; its signature is `HMAC-SHA256(secret, payload)`. The
//     gateway is stateless and cannot map a Channel to its User, so without
//     self-description it could not address a Durable Object at all without
//     first creating one on an anonymous caller's word.
//  2. **In the User Durable Object**, `SHA-256(token)` is compared against the
//     durable `channel-token:<channelId>` record. That record is the authority:
//     `disconnect` deletes it, so a token that verified at the edge is refused
//     the instant the Channel no longer holds it.
//
// The token is used twice on the wire, deliberately. It is the last path
// segment of `/api/plugins/channels/telegram/:token`, *and* it is what the
// platform is told to send back in `X-Telegram-Bot-Api-Secret-Token`. A caller
// that has guessed a URL out of a log still cannot forge the header, and a
// caller that replays the header at another Channel's path is refused because
// the claims and the path must agree.
//
// The secret is derived from the deployment's credential keyring rather than
// added as a fourth Worker secret: the keyring is already the root of every
// User-scoped secret this product holds, and a *derived* key with its own label
// cannot be confused with the AES key it came from. Nothing here writes key
// material to durable storage, and no view carries any.
import { parseCredentialKeyringV1 } from "@frockbot/connection-core";
import {
  channelExactKeys,
  channelRecord,
  ChannelDecodeError,
  isChannelIdV1,
} from "./records.js";

/** The domain separation label the Channel token key is derived under. */
const DERIVATION_LABEL = "frockbot/channels/token/v1";

/** Longest token the door will look at before refusing it unread. */
const TOKEN_MAX = 2_048;

/** Longest inbound delivery body the door accepts, before anything is parsed. */
export const CHANNEL_WEBHOOK_BODY_MAX_BYTES = 64 * 1024;

/** The self-describing claims a Channel token carries. */
export interface ChannelTokenClaimsV1 {
  /** User. */
  u: string;
  /** Channel. */
  c: string;
  /** Connection. */
  k: string;
  /** Per-mint nonce, so a rotation produces a different token every time. */
  n: string;
  /** Key version. */
  v: number;
}

/** The durable key record. Holds a digest, never the token. */
export interface ChannelTokenKeyV1 {
  schemaVersion: 1;
  channelId: string;
  connectionId: string;
  keyVersion: number;
  digest: string;
  createdAt: string;
}

export class ChannelTokenError extends Error {
  override readonly name = "ChannelTokenError";
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
export function channelConstantTimeEqualsV1(
  left: string,
  right: string,
): boolean {
  const a = TEXT.encode(left);
  const b = TEXT.encode(right);
  let mismatch = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * The signing secret for Channel tokens, derived from the credential keyring.
 *
 * Derived, never the keyring's own key: the AES key seals User credentials and
 * this one signs door keys, and two purposes sharing one key is how a break in
 * either becomes a break in both. The label is fixed, so the derivation is
 * reproducible on every Worker instance without any state at all.
 */
export async function channelTokenSecretV1(keyring: string): Promise<string> {
  const parsed = parseCredentialKeyringV1(keyring);
  const material = parsed.keys[parsed.currentKeyId];
  if (!material) {
    throw new ChannelTokenError(500, "credential keyring has no current key");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64url(material) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    key,
    // NUL-separated, so no label and key id can ever concatenate into the
    // same input as a different pair.
    TEXT.encode(`${DERIVATION_LABEL}\u0000${parsed.currentKeyId}`),
  );
  return base64url(new Uint8Array(derived));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new ChannelTokenError(
      500,
      "the Channel token secret is missing or too short",
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

/** `SHA-256` of a token, hex. The only form of a key the User keeps. */
export async function channelTokenDigestV1(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", TEXT.encode(token)));
}

/** A fresh nonce, so two mints for one Channel are two different tokens. */
export function channelTokenNonceV1(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(12)));
}

/** Mint the token for one Channel at one key version. Deterministic in its claims. */
export async function mintChannelTokenV1(
  secret: string,
  claims: ChannelTokenClaimsV1,
): Promise<string> {
  const payload = base64url(
    TEXT.encode(
      JSON.stringify({
        u: claims.u,
        c: claims.c,
        k: claims.k,
        n: claims.n,
        v: claims.v,
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
 * Verify a presented token and answer with the claims it carries.
 *
 * This is the edge's whole decision. It says nothing about whether the Channel
 * exists, is still active, or still holds this key — those are the User Durable
 * Object's to answer, and are answered only after the token proved it was
 * minted here.
 */
export async function verifyChannelTokenV1(
  secret: string,
  token: string,
): Promise<ChannelTokenClaimsV1> {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > TOKEN_MAX
  ) {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
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
  if (!channelConstantTimeEqualsV1(expected, presented)) {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
  return decodeChannelTokenClaimsV1(decoded);
}

export function decodeChannelTokenClaimsV1(
  value: unknown,
): ChannelTokenClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
  const candidate = value as Record<string, unknown>;
  const identifier = (key: "u" | "c" | "k" | "n"): string => {
    const held = candidate[key];
    if (typeof held !== "string" || held.length === 0 || held.length > 256) {
      throw new ChannelTokenError(404, "Channel webhook is unknown");
    }
    if (key === "c" && !isChannelIdV1(held)) {
      throw new ChannelTokenError(404, "Channel webhook is unknown");
    }
    return held;
  };
  if (
    !Number.isSafeInteger(candidate.v) ||
    (candidate.v as number) < 1 ||
    (candidate.v as number) > 1_000_000
  ) {
    throw new ChannelTokenError(404, "Channel webhook is unknown");
  }
  return {
    u: identifier("u"),
    c: identifier("c"),
    k: identifier("k"),
    n: identifier("n"),
    v: candidate.v as number,
  };
}

export function decodeChannelTokenKeyV1(
  value: unknown,
  label = "Channel token key",
): ChannelTokenKeyV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    [
      "schemaVersion",
      "channelId",
      "connectionId",
      "keyVersion",
      "digest",
      "createdAt",
    ],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  if (!isChannelIdV1(candidate.connectionId)) {
    throw new ChannelDecodeError(`${label} connectionId is invalid`);
  }
  if (
    !Number.isSafeInteger(candidate.keyVersion) ||
    (candidate.keyVersion as number) < 1
  ) {
    throw new ChannelDecodeError(`${label} keyVersion is invalid`);
  }
  if (
    typeof candidate.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.digest)
  ) {
    throw new ChannelDecodeError(`${label} digest is invalid`);
  }
  if (
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new ChannelDecodeError(`${label} createdAt is invalid`);
  }
  return {
    schemaVersion: 1,
    channelId: candidate.channelId,
    connectionId: candidate.connectionId,
    keyVersion: candidate.keyVersion as number,
    digest: candidate.digest,
    createdAt: candidate.createdAt,
  };
}
