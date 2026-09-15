// Who is at the door.
//
// Cloudflare Access authenticates every request to this hostname and hands the
// Worker a signed assertion. The Worker verifies it itself rather than trusting
// the header's presence: a request that reached the origin without going
// through Access — a misconfigured application, a hostname added later — would
// otherwise administer the deployment.
//
// Web Crypto only. The whole verification is a signature check and four claim
// checks, and a dependency for that would be a dependency in the one Worker
// whose compromise is total.

import { adminEmailsV1 } from "@frockbot/app/admin/shared";

/** The assertion Access sets on the request, and the cookie it also sets. */
const ASSERTION_HEADER = "cf-access-jwt-assertion";
const ASSERTION_COOKIE = "CF_Authorization";

/** How long a fetched key set is reused before it is read again. */
const KEY_CACHE_MS = 60 * 60 * 1000;

/** Clock skew allowed on `nbf` and `iat`, in seconds. */
const SKEW_SECONDS = 60;

export interface AccessIdentityV1 {
  /** The verified email Access authenticated, lower-cased. */
  email: string;
  /** The Access user id, which the token calls `sub`. */
  subject: string;
}

export type AccessRefusalReasonV1 =
  | "no-token"
  | "malformed"
  | "unsupported-algorithm"
  | "unknown-key"
  | "bad-signature"
  | "wrong-audience"
  | "wrong-issuer"
  | "expired"
  | "not-yet-valid"
  | "no-email"
  | "keys-unavailable";

export type AccessVerificationV1 =
  | { ok: true; identity: AccessIdentityV1 }
  | { ok: false; reason: AccessRefusalReasonV1 };

export interface AccessConfigurationV1 {
  /** The Zero Trust team domain, e.g. `frockbot.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
}

export interface AccessVerifierOptionsV1 {
  /** Seconds since the epoch; the clock the claims are checked against. */
  now?: () => number;
  /** How the key set is read. The default is `fetch` against the team domain. */
  fetchKeys?: (url: string) => Promise<Response>;
}

interface JsonWebKeyEntry {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface CachedKeys {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

const keyCache = new Map<string, CachedKeys>();

/** `frockbot.cloudflareaccess.com`, however the variable spells it. */
export function accessTeamHostV1(teamDomain: string): string {
  return teamDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function accessTokenFromRequestV1(request: Request): string | undefined {
  const asserted = request.headers.get(ASSERTION_HEADER)?.trim();
  if (asserted) return asserted;
  const cookies = request.headers.get("cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== ASSERTION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (value) return value;
  }
  return undefined;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlJson(value: string): Record<string, unknown> | undefined {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return undefined;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function importKeys(
  host: string,
  options: AccessVerifierOptionsV1,
): Promise<Map<string, CryptoKey> | undefined> {
  const read = options.fetchKeys ?? ((url: string) => fetch(url));
  let response: Response;
  try {
    response = await read(`https://${host}/cdn-cgi/access/certs`);
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let document: unknown;
  try {
    document = await response.json();
  } catch {
    return undefined;
  }
  const entries = (document as { keys?: unknown })?.keys;
  if (!Array.isArray(entries)) return undefined;
  const keys = new Map<string, CryptoKey>();
  for (const entry of entries) {
    const key = entry as Partial<JsonWebKeyEntry>;
    if (
      typeof key.kid !== "string" ||
      key.kty !== "RSA" ||
      typeof key.n !== "string" ||
      typeof key.e !== "string" ||
      (key.alg !== undefined && key.alg !== "RS256")
    ) {
      continue;
    }
    try {
      keys.set(
        key.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      // A key this runtime cannot import verifies nothing; the others still do.
    }
  }
  return keys.size > 0 ? keys : undefined;
}

/**
 * The signing key for one `kid`.
 *
 * Access rotates its keys, so an unknown `kid` is a cache that has gone stale
 * rather than a forged token: the set is read again once, and only a `kid` the
 * fresh set does not name refuses the request.
 */
async function signingKey(
  host: string,
  kid: string,
  options: AccessVerifierOptionsV1,
): Promise<CryptoKey | undefined | "unavailable"> {
  const now = (options.now?.() ?? Date.now() / 1000) * 1000;
  const cached = keyCache.get(host);
  if (cached && now - cached.fetchedAt < KEY_CACHE_MS) {
    const key = cached.keys.get(kid);
    if (key) return key;
  }
  const keys = await importKeys(host, options);
  if (!keys)
    return cached ? (cached.keys.get(kid) ?? undefined) : "unavailable";
  keyCache.set(host, { fetchedAt: now, keys });
  return keys.get(kid);
}

function audienceMatches(claim: unknown, audience: string): boolean {
  if (typeof claim === "string") return claim === audience;
  if (Array.isArray(claim)) {
    return claim.some((entry) => entry === audience);
  }
  return false;
}

/**
 * Verify one Access assertion: RS256 over the team's published keys, this
 * application's audience, this team as the issuer, and a live expiry.
 */
export async function verifyAccessTokenV1(
  token: string,
  configuration: AccessConfigurationV1,
  options: AccessVerifierOptionsV1 = {},
): Promise<AccessVerificationV1> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = base64UrlJson(encodedHeader);
  const payload = base64UrlJson(encodedPayload);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "unsupported-algorithm" };
  }

  const host = accessTeamHostV1(configuration.teamDomain);
  const key = await signingKey(host, header.kid, options);
  if (key === "unavailable") return { ok: false, reason: "keys-unavailable" };
  if (!key) return { ok: false, reason: "unknown-key" };

  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) return { ok: false, reason: "bad-signature" };

  // Claims after the signature: an unverified token's claims are the
  // attacker's, and answering on them would report their audience as ours.
  if (!audienceMatches(payload.aud, configuration.audience)) {
    return { ok: false, reason: "wrong-audience" };
  }
  if (payload.iss !== `https://${host}`) {
    return { ok: false, reason: "wrong-issuer" };
  }
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + SKEW_SECONDS) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (typeof payload.iat === "number" && payload.iat > now + SKEW_SECONDS) {
    return { ok: false, reason: "not-yet-valid" };
  }
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, reason: "no-email" };

  return {
    ok: true,
    identity: {
      email,
      subject: typeof payload.sub === "string" ? payload.sub : "",
    },
  };
}

/**
 * Whether this verified identity administers the deployment.
 *
 * Access says who may open the portal at all; `FROCKBOT_ADMIN_EMAILS` says who
 * may administer, and it is the same secret the app reads for who bypasses
 * admission. An unset list admits nobody: a portal that administered for
 * everyone Access let in would be one misconfigured Access policy away from
 * open administration.
 */
export function isPortalAdminV1(
  email: string,
  configuredEmails: string | undefined,
): boolean {
  return adminEmailsV1(configuredEmails).has(email.trim().toLowerCase());
}

/** Forget every cached key set. Tests use it; nothing in the Worker does. */
export function resetAccessKeyCacheV1(): void {
  keyCache.clear();
}
