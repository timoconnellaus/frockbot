/**
 * Sign in with Cloudflare: the Authorization Code flow with PKCE, as a
 * confidential client, against Cloudflare's OAuth server.
 *
 * The client is registered on Tim's account (Manage Account → OAuth clients)
 * and made public, which needs frockbot.com's domain verified. Its id and
 * secret are the marketing Worker's `CLOUDFLARE_OAUTH_CLIENT_ID` and
 * `CLOUDFLARE_OAUTH_CLIENT_SECRET`; with either unset, `/deploy` says the
 * hosted flow is unavailable and points at the repository.
 */

export const CLOUDFLARE_AUTHORIZE_URL_V1 =
  "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_TOKEN_URL_V1 =
  "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_REVOKE_URL_V1 =
  "https://dash.cloudflare.com/oauth2/revoke";

/**
 * What a deploy needs, and no more. The same list is the client's registered
 * scopes: a scope asked for here that the registration lacks fails the whole
 * consent. There is no billing scope because Cloudflare cannot grant one to a
 * third party; the Workers plan is read by trying what only Paid allows.
 */
export const DEPLOY_SCOPES_V1 = [
  "offline_access",
  "user-details.read",
  "account-settings.read",
  "workers-scripts.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "workers-r2-bucket-item.write",
  "d1.write",
  "vectorize.write",
  "queues.write",
  "ai.read",
  "access-org.write",
  "access-app.write",
  "access-policy.write",
  "teams.read",
  // The Plugin build service runs in a container the bundle's deployer
  // creates and rolls to each release's image.
  "containers.write",
] as const;

export interface OAuthClientV1 {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface OAuthTokensV1 {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly scope?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function randomTokenV1(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A short lowercase suffix for a name Cloudflare needs unique. */
export function randomSuffixV1(): string {
  return [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function pkceChallengeV1(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

export async function authorizeUrlV1(
  client: OAuthClientV1,
  state: string,
  verifier: string,
  /** Ask again even if already granted: how a person picks another account. */
  reconsent = false,
): Promise<string> {
  const url = new URL(CLOUDFLARE_AUTHORIZE_URL_V1);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("scope", DEPLOY_SCOPES_V1.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallengeV1(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (reconsent) url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function tokenRequest(
  client: OAuthClientV1,
  body: Record<string, string>,
  fetcher: typeof fetch,
  now: number,
): Promise<OAuthTokensV1> {
  const response = await fetcher(CLOUDFLARE_TOKEN_URL_V1, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof payload.access_token !== "string") {
    const reason =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `status ${response.status}`;
    throw new Error(`Cloudflare sign-in failed: ${reason}`);
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string"
      ? { refreshToken: payload.refresh_token }
      : {}),
    // A minute early, so a call is never made with a token about to lapse.
    expiresAt: now + Math.max(60, expiresIn - 60) * 1000,
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}

export function exchangeCodeV1(
  client: OAuthClientV1,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OAuthTokensV1> {
  return tokenRequest(
    client,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
    },
    fetcher,
    now,
  );
}

/**
 * A fresh access token. Cloudflare rotates the refresh token on use, so the
 * answer's replaces the one given, and an old one is never redeemed twice.
 */
export async function refreshTokensV1(
  client: OAuthClientV1,
  tokens: OAuthTokensV1,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<OAuthTokensV1> {
  if (!tokens.refreshToken)
    throw new Error("Your Cloudflare sign-in has expired");
  const fresh = await tokenRequest(
    client,
    { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    fetcher,
    now,
  );
  return fresh.refreshToken
    ? fresh
    : { ...fresh, refreshToken: tokens.refreshToken };
}

/** Best effort: the token lapses by itself if Cloudflare doesn't answer. */
export async function revokeTokenV1(
  client: OAuthClientV1,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetcher(CLOUDFLARE_REVOKE_URL_V1, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Nothing to do: an unrevoked token still expires.
  }
}
