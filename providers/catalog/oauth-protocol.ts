/** Hosted equivalents of pi-ai 0.85.1 OAuth flows; no loopback servers or ambient credentials. */
import { withDeadlineV1 } from "@frockbot/core/deadline";
import type { OAuthProviderIdV1 } from "./registry.js";
export const OAUTH_SECRET_PREFIX = "frockbot-oauth:";
export interface OAuthTokenV1 {
  access: string;
  refresh: string;
  expires: number;
}
export interface OAuthFlowV1 {
  authorizationUrl: string;
  userCode?: string;
  deviceCode?: string;
  verifier?: string;
  callbackUrl?: string;
  state: string;
  expiresAt: number;
  intervalMs: number;
}
const clients = {
  xai: "b1a00492-073a-47ea-816f-4c329264a828",
  radius: "pi-gateway",
  openrouter: "",
};
const endpoints = {
  xai: [
    "https://auth.x.ai/oauth2/device/code",
    "https://auth.x.ai/oauth2/token",
  ],
  radius: [
    "https://radius.pi.dev/v1/oauth/device",
    "https://radius.pi.dev/v1/oauth/token",
  ],
  openrouter: [
    "https://openrouter.ai/auth",
    "https://openrouter.ai/api/v1/auth/keys",
  ],
} satisfies Record<OAuthProviderIdV1, [string, string]>;
const scopes: Partial<Record<OAuthProviderIdV1, string>> = {
  xai: "openid profile email offline_access grok-cli:access api:access",
  radius: "gateway offline_access",
};
function string(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 16384)
    throw new Error("Invalid OAuth response");
  return v;
}
function seconds(v: unknown, fallback: number): number {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 86400 * 365)
    throw new Error("Invalid OAuth expiry");
  return n;
}
async function request(
  url: string,
  fields: Record<string, string>,
  json = false,
) {
  const deadline = withDeadlineV1(30000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": json
          ? "application/json"
          : "application/x-www-form-urlencoded",
      },
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields),
      signal: deadline.signal,
    });
    const body = (await response.json().catch(() => {
      if (response.ok) throw new Error("Invalid OAuth response");
      return {};
    })) as Record<string, unknown>;
    return { response, body };
  } finally {
    deadline.clear();
  }
}
function success(result: Awaited<ReturnType<typeof request>>) {
  if (!result.response.ok || result.body.error)
    throw new Error(
      `OAuth request rejected (${result.response.status}); sign in again`,
    );
  return result.body;
}
function token(
  body: Record<string, unknown>,
  now: number,
  previousRefresh?: string,
): OAuthTokenV1 {
  return {
    access: string(body.access_token),
    refresh: string(body.refresh_token ?? previousRefresh),
    expires: now + seconds(body.expires_in, 3600) * 1000,
  };
}
function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function startOAuthV1(
  provider: OAuthProviderIdV1,
  state: string,
  callbackUrl?: string,
  now = Date.now(),
): Promise<OAuthFlowV1> {
  if (provider === "openrouter") {
    if (!callbackUrl || new URL(callbackUrl).protocol !== "https:")
      throw new Error("OpenRouter sign-in requires an HTTPS callback");
    const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const callback = new URL(callbackUrl);
    callback.searchParams.set("state", state);
    const url = new URL(endpoints.openrouter[0]);
    url.search = new URLSearchParams({
      callback_url: callback.href,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return {
      authorizationUrl: url.href,
      verifier,
      callbackUrl: callback.href,
      state,
      expiresAt: now + 600000,
      intervalMs: 5000,
    };
  }
  const body = success(
    await request(endpoints[provider][0], {
      client_id: clients[provider],
      ...(scopes[provider] ? { scope: scopes[provider] } : {}),
    }),
  );
  const authorizationUrl = string(
    body.verification_uri_complete ?? body.verification_uri,
  );
  if (new URL(authorizationUrl).protocol !== "https:")
    throw new Error("Invalid OAuth sign-in URL");
  return {
    authorizationUrl,
    userCode: string(body.user_code),
    deviceCode: string(body.device_code),
    state,
    expiresAt: now + Math.min(seconds(body.expires_in, 900), 1800) * 1000,
    intervalMs: Math.max(1000, seconds(body.interval, 5) * 1000),
  };
}
export async function pollOAuthV1(
  provider: OAuthProviderIdV1,
  flow: OAuthFlowV1,
  code?: string,
  now = Date.now(),
): Promise<OAuthTokenV1 | "pending" | "slow-down"> {
  if (now >= flow.expiresAt) throw new Error("Sign-in expired; start again");
  if (provider === "openrouter") {
    if (!code) return "pending";
    const redirect = new URL(code);
    if (
      redirect.origin !== new URL(flow.callbackUrl!).origin ||
      redirect.pathname !== new URL(flow.callbackUrl!).pathname ||
      redirect.searchParams.get("state") !== flow.state
    )
      throw new Error("Sign-in callback does not match this attempt");
    const body = success(
      await request(
        endpoints.openrouter[1],
        {
          code: string(redirect.searchParams.get("code")),
          code_verifier: flow.verifier!,
          code_challenge_method: "S256",
        },
        true,
      ),
    );
    return {
      access: string(body.key),
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    };
  }
  const result = await request(endpoints[provider][1], {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clients[provider],
    device_code: flow.deviceCode!,
  });
  if (result.body.error === "authorization_pending") return "pending";
  if (result.body.error === "slow_down") return "slow-down";
  return token(success(result), now);
}
export async function refreshOAuthV1(
  provider: OAuthProviderIdV1,
  current: OAuthTokenV1,
  now = Date.now(),
): Promise<OAuthTokenV1> {
  if (provider === "openrouter") return current;
  return token(
    success(
      await request(endpoints[provider][1], {
        grant_type: "refresh_token",
        client_id: clients[provider],
        refresh_token: current.refresh,
      }),
    ),
    now,
    current.refresh,
  );
}
export function encodeOAuthTokenV1(token: OAuthTokenV1): string {
  return OAUTH_SECRET_PREFIX + JSON.stringify(token);
}
export function decodeOAuthTokenV1(secret: string): OAuthTokenV1 | undefined {
  if (!secret.startsWith(OAUTH_SECRET_PREFIX)) return undefined;
  const v = JSON.parse(
    secret.slice(OAUTH_SECRET_PREFIX.length),
  ) as OAuthTokenV1;
  string(v.access);
  if (typeof v.refresh !== "string" || !Number.isFinite(v.expires))
    throw new Error("Invalid OAuth credential");
  return v;
}
