/** Hosted equivalents of pi-ai 0.85.1 OAuth flows; no loopback servers or ambient credentials. */
import { oauthProviderIdsV1 } from "./definition.js";
export { oauthProviderIdsV1 };
export type OAuthProviderIdV1 = (typeof oauthProviderIdsV1)[number];
export const OAUTH_SECRET_PREFIX = "frockbot-oauth:";
export interface OAuthTokenV1 {
  access: string;
  refresh: string;
  expires: number;
  baseUrl?: string;
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
  "openai-codex": "app_EMoamEEZ73f0CkXaXp7hrann",
  "github-copilot": "Iv1.b507a08c87ecfe98",
  "kimi-coding": "17e5f671-d194-4dfb-9706-5516cb48c098",
  xai: "b1a00492-073a-47ea-816f-4c329264a828",
  radius: "pi-gateway",
  openrouter: "",
};
const endpoints = {
  "openai-codex": [
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/oauth/token",
  ],
  "github-copilot": [
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
  ],
  "kimi-coding": [
    "https://auth.kimi.com/api/oauth/device_authorization",
    "https://auth.kimi.com/api/oauth/token",
  ],
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
  "github-copilot": "read:user",
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
    signal: AbortSignal.timeout(30000),
  });
  const body = (await response.json().catch(() => {
    if (response.ok) throw new Error("Invalid OAuth response");
    return {};
  })) as Record<string, unknown>;
  return { response, body };
}
function oauthErrorCode(body: Record<string, unknown>): unknown {
  return body.error && typeof body.error === "object"
    ? (body.error as Record<string, unknown>).code
    : body.error;
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
    await request(
      endpoints[provider][0],
      {
        client_id: clients[provider],
        ...(scopes[provider] ? { scope: scopes[provider] } : {}),
      },
      provider === "openai-codex",
    ),
  );
  const authorizationUrl =
    provider === "openai-codex"
      ? "https://auth.openai.com/codex/device"
      : string(body.verification_uri_complete ?? body.verification_uri);
  if (new URL(authorizationUrl).protocol !== "https:")
    throw new Error("Invalid OAuth sign-in URL");
  return {
    authorizationUrl,
    userCode: string(body.user_code),
    deviceCode: string(
      provider === "openai-codex" ? body.device_auth_id : body.device_code,
    ),
    state,
    expiresAt: now + Math.min(seconds(body.expires_in, 900), 1800) * 1000,
    intervalMs: Math.max(1000, seconds(body.interval, 5) * 1000),
  };
}
async function copilotToken(
  refresh: string,
  now: number,
): Promise<OAuthTokenV1> {
  const response = await fetch(
    "https://api.github.com/copilot_internal/v2/token",
    {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${refresh}`,
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Copilot authorization rejected (${response.status}); sign in again`,
    );
  const body = (await response.json().catch(() => {
    if (response.ok) throw new Error("Invalid OAuth response");
    return {};
  })) as Record<string, unknown>;
  const access = string(body.token);
  const proxy = /(?:^|;)proxy-ep=([^;]+)/.exec(access)?.[1];
  const host =
    proxy?.replace(/^proxy\./, "api.") ?? "api.individual.githubcopilot.com";
  if (!/^(?:[a-z0-9-]+\.)*githubcopilot\.com$/.test(host))
    throw new Error("Invalid Copilot API host");
  const expires = Number(body.expires_at) * 1000;
  if (!Number.isFinite(expires) || expires <= now)
    throw new Error("Copilot returned an expired token");
  return { access, refresh, expires, baseUrl: `https://${host}` };
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
  if (provider === "openai-codex") {
    const result = await request(
      "https://auth.openai.com/api/accounts/deviceauth/token",
      { device_auth_id: flow.deviceCode!, user_code: flow.userCode! },
      true,
    );
    if (
      result.response.status === 403 ||
      result.response.status === 404 ||
      oauthErrorCode(result.body) === "deviceauth_authorization_pending"
    )
      return "pending";
    if (oauthErrorCode(result.body) === "slow_down") return "slow-down";
    const body = success(result);
    return token(
      success(
        await request(endpoints[provider][1], {
          grant_type: "authorization_code",
          client_id: clients[provider],
          code: string(body.authorization_code),
          code_verifier: string(body.code_verifier),
          redirect_uri: "https://auth.openai.com/deviceauth/callback",
        }),
      ),
      now,
    );
  }
  const result = await request(endpoints[provider][1], {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clients[provider],
    device_code: flow.deviceCode!,
  });
  if (oauthErrorCode(result.body) === "authorization_pending") return "pending";
  if (oauthErrorCode(result.body) === "slow_down") return "slow-down";
  const body = success(result);
  if (provider === "github-copilot")
    return copilotToken(string(body.access_token), now);
  return token(body, now);
}
export async function refreshOAuthV1(
  provider: OAuthProviderIdV1,
  current: OAuthTokenV1,
  now = Date.now(),
): Promise<OAuthTokenV1> {
  if (provider === "openrouter") return current;
  if (provider === "github-copilot") return copilotToken(current.refresh, now);
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
  if (
    v.baseUrl &&
    !/^https:\/\/(?:[a-z0-9-]+\.)*githubcopilot\.com$/.test(v.baseUrl)
  )
    throw new Error("Invalid OAuth endpoint");
  return v;
}
