/**
 * Sign-in as a simple deployment does it: Cloudflare Access in front of the
 * Worker, and nothing stored anywhere.
 *
 * Access authenticates the person against whatever identity provider the
 * deployer configured, and its policy is also the allowlist — which is why
 * this Package declares `admission: "package"` and the deployment never asks
 * the admission authority (ADR 0028). There is no D1, no session cookie of our
 * own, no identity row and no sign-in UI: this Package verifies the token
 * Access issued, and that is the whole of it.
 */
import type {
  AuthIdentityV1,
  AuthPackageBuildV1,
  AuthPackageV1,
} from "@frockbot/core/contracts";
import { signInFailedV1 } from "../shared.js";
import {
  accessKeysV1,
  accessLogoutUrlV1,
  verifyAccessTokenV1,
  type AccessKeysV1,
} from "./token.js";

export interface AccessEnvironmentV1 {
  /** The Zero Trust team domain, e.g. `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
}

const TOKEN_HEADER = "cf-access-jwt-assertion";
const TOKEN_COOKIE = "CF_Authorization";

/** The Access token this request carries, from the header or the cookie. */
export function accessTokenOfV1(headers: Headers): string | undefined {
  const asserted = headers.get(TOKEN_HEADER)?.trim();
  if (asserted) return asserted;
  // A document navigation the browser makes itself carries only the cookie;
  // Access adds the header to requests it proxies.
  for (const pair of headers.get("cookie")?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== TOKEN_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The User id for an Access identity.
 *
 * Derived from the token's `sub`, which Access keeps stable for an identity, so
 * the same person reaches the same User on every sign-in without anything
 * being stored. Hashed rather than passed through because a User id names a
 * Durable Object and appears in a URL, and an identity provider's subject is
 * not bound to that shape.
 */
export async function accessUserIdV1(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`frockbot-access-identity-v1:${subject}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `access-${hex.slice(0, 32)}`;
}

function unconfigured(): AuthPackageV1 {
  const refuse = () =>
    Promise.resolve(
      Response.json(
        { error: "authentication is not configured" },
        { status: 503 },
      ),
    );
  return {
    handler: refuse,
    getSession: () => Promise.resolve(null),
    signOut: refuse,
    startSignIn: refuse,
  };
}

/** Sign-in is not this Worker's route on this build; Access owns it. */
function servedByAccess(): Response {
  return signInFailedV1(
    404,
    "This deployment signs in through Cloudflare Access.",
  );
}

export function createAccessPackageV1(
  environment: AccessEnvironmentV1,
  options: { keys?: AccessKeysV1; now?: () => number } = {},
): AuthPackageV1 {
  const teamDomain = environment.ACCESS_TEAM_DOMAIN?.trim();
  const audience = environment.ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return unconfigured();
  const keys = options.keys ?? accessKeysV1({ teamDomain, now: options.now });

  return {
    handler: () => Promise.resolve(servedByAccess()),
    getSession: async (headers): Promise<AuthIdentityV1 | null> => {
      const token = accessTokenOfV1(headers);
      if (!token) return null;
      try {
        const claims = await verifyAccessTokenV1(token, {
          keys,
          teamDomain,
          audience,
          ...(options.now ? { now: options.now } : {}),
        });
        return {
          user: {
            id: await accessUserIdV1(claims.subject),
            email: claims.email,
            // Access will not issue a token for an address the identity
            // provider has not proven belongs to the person signing in.
            emailVerified: true,
          },
        };
      } catch (error) {
        // A refused token is an unauthenticated request, not an outage: the
        // reason goes to the operator, and the visitor is simply nobody.
        console.error(
          `Cloudflare Access token refused: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    signOut: () =>
      Promise.resolve(
        new Response(null, {
          status: 303,
          headers: {
            location: accessLogoutUrlV1(teamDomain),
            "cache-control": "no-store",
          },
        }),
      ),
    // `/native/authorize` sits behind Access, so a request that reaches the
    // Worker already carries an identity. Reaching here means the Access
    // application does not cover this path, and redirecting would loop.
    startSignIn: () =>
      Promise.resolve(
        signInFailedV1(
          401,
          "Cloudflare Access did not authenticate this request.",
        ),
      ),
  };
}

export const ACCESS_AUTH_PACKAGE_V1: AuthPackageBuildV1<AccessEnvironmentV1> = {
  id: "access",
  required: [
    {
      name: "ACCESS_TEAM_DOMAIN",
      why: "The Zero Trust team whose public keys sign every Access token, and whose logout ends a session.",
    },
    {
      name: "ACCESS_AUD",
      why: "The Access application's audience tag. Absent, a token minted for another application would be accepted.",
    },
  ],
  admission: "package",
  create: (environment) => createAccessPackageV1(environment),
};
