/**
 * The Cloudflare Access application token, verified here rather than trusted.
 *
 * Access puts a signed JWT on every request it lets through, in the
 * `Cf-Access-Jwt-Assertion` header and in the `CF_Authorization` cookie. The
 * header is absent on a plain document navigation the browser makes itself, so
 * both are read. Nothing about the request is believed until the signature,
 * the audience, the issuer and the expiry all check out: a Worker on a
 * `workers.dev` hostname is reachable directly, and an unverified header is
 * just a claim anybody can make.
 *
 * Web Crypto does the verification. `jose` is in the lockfile only as
 * better-auth's dependency, and the Access Package may not depend on anything
 * better-auth brings in.
 */

/** A verified Access token's claims, as an identity is derived from them. */
export interface AccessTokenClaimsV1 {
  /** Stable per identity for the life of the Access application. */
  readonly subject: string;
  readonly email: string;
  readonly expiresAt: number;
}

/** Why a token was refused, for the Worker log. Never shown to a visitor. */
export class AccessTokenError extends Error {
  override readonly name = "AccessTokenError";
}

interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string;
}

/**
 * The team's signing keys, held for `ttlMs`.
 *
 * Access rotates these, and a rotation must not turn into a 401 for everybody,
 * so an unknown `kid` refetches immediately rather than waiting out the TTL.
 * An isolate lives minutes, so this is a per-isolate cache and never a store.
 */
export interface AccessKeysV1 {
  find(kid: string): Promise<CryptoKey | undefined>;
}

const JWKS_TTL_MS = 300_000;

export function accessKeysV1(options: {
  teamDomain: string;
  fetcher?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}): AccessKeysV1 {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? JWKS_TTL_MS;
  const url = `${teamOriginV1(options.teamDomain)}/cdn-cgi/access/certs`;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;
  let inFlight: Promise<Map<string, CryptoKey>> | undefined;

  async function load(): Promise<Map<string, CryptoKey>> {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new AccessTokenError(
        `Access certs answered ${response.status} for ${url}`,
      );
    }
    const document: unknown = await response.json();
    const listed =
      document && typeof document === "object" && "keys" in document
        ? (document as { keys?: unknown }).keys
        : undefined;
    if (!Array.isArray(listed)) {
      throw new AccessTokenError("Access certs carried no keys");
    }
    const loaded = new Map<string, CryptoKey>();
    for (const jwk of listed as JsonWebKeyWithKid[]) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      loaded.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { ...jwk, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    keys = loaded;
    fetchedAt = now();
    return loaded;
  }

  function loadOnce(): Promise<Map<string, CryptoKey>> {
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    async find(kid) {
      const fresh = now() - fetchedAt < ttlMs;
      const held = fresh ? keys.get(kid) : undefined;
      if (held) return held;
      return (await loadOnce()).get(kid);
    },
  };
}

/** The team's Zero Trust origin, however the deployment spelled the domain. */
export function teamOriginV1(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Where Access ends a session for the whole team. */
export function accessLogoutUrlV1(teamDomain: string): string {
  return `${teamOriginV1(teamDomain)}/cdn-cgi/access/logout`;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new AccessTokenError("token is not base64url");
  }
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
}

function jsonSegment(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(segment)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccessTokenError("token segment is not an object");
  }
  return value as Record<string, unknown>;
}

function issuerMatches(issuer: unknown, teamDomain: string): boolean {
  if (typeof issuer !== "string") return false;
  const expected = teamOriginV1(teamDomain);
  return issuer === expected || issuer === `${expected}/`;
}

function audienceMatches(audience: unknown, expected: string): boolean {
  const claimed = Array.isArray(audience) ? audience : [audience];
  return claimed.some((value) => value === expected);
}

/**
 * The claims of an Access token, or a throw.
 *
 * Every check Access's own documentation names, in the order a forged token
 * fails them: shape, key, signature, audience, issuer, expiry. The audience is
 * the application's own tag, and is what stops a token minted for another
 * application in the same team from opening this one.
 */
export async function verifyAccessTokenV1(
  token: string,
  options: {
    keys: AccessKeysV1;
    teamDomain: string;
    audience: string;
    now?: () => number;
  },
): Promise<AccessTokenClaimsV1> {
  const now = options.now ?? Date.now;
  if (token.length > 8192) throw new AccessTokenError("token is too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessTokenError("token is not a JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = jsonSegment(encodedHeader);
  if (header.alg !== "RS256") {
    throw new AccessTokenError(`token algorithm ${String(header.alg)}`);
  }
  if (typeof header.kid !== "string") {
    throw new AccessTokenError("token names no key");
  }
  const key = await options.keys.find(header.kid);
  if (!key) throw new AccessTokenError("token names an unknown key");
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) throw new AccessTokenError("token signature does not verify");
  const payload = jsonSegment(encodedPayload);
  if (!audienceMatches(payload.aud, options.audience)) {
    throw new AccessTokenError("token is for another Access application");
  }
  if (!issuerMatches(payload.iss, options.teamDomain)) {
    throw new AccessTokenError("token is from another Access team");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now()) {
    throw new AccessTokenError("token has expired");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AccessTokenError("token names no identity");
  }
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email.length === 0) throw new AccessTokenError("token carries no email");
  return { subject: payload.sub, email, expiresAt: payload.exp * 1000 };
}
