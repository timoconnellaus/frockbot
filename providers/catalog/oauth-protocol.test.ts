import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeOAuthTokenV1,
  encodeOAuthTokenV1,
  type OAuthFlowV1,
  type OAuthTokenV1,
  pollOAuthV1,
  refreshOAuthV1,
  startOAuthV1,
} from "./oauth-protocol.js";
import type { OAuthProviderIdV1 } from "./registry.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mockFetch(
  responses: Array<
    Response | ((call: FetchCall) => Response | Promise<Response>)
  >,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const call = {
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ...(init ? { init } : {}),
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected OAuth request to ${call.url}`);
    return typeof next === "function" ? next(call) : next;
  }) as typeof fetch;
  return calls;
}

function fields(call: FetchCall): Record<string, string> {
  const body = call.init?.body;
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, string>;
  }
  throw new Error("OAuth request had no inspectable body");
}

function deviceFlow(provider: OAuthProviderIdV1): OAuthFlowV1 {
  return {
    authorizationUrl: `https://${provider}.example/activate`,
    userCode: "USER-CODE",
    deviceCode: "DEVICE-CODE",
    state: "attempt-state",
    expiresAt: 2_000_000,
    intervalMs: 5_000,
  };
}

describe("hosted OAuth protocol", () => {
  test("starts every provider flow with the expected request shape", async () => {
    const cases: Array<{
      provider: Exclude<OAuthProviderIdV1, "openrouter">;
      endpoint: string;
      scope?: string;
      response: Record<string, unknown>;
    }> = [
      {
        provider: "xai",
        endpoint: "https://auth.x.ai/oauth2/device/code",
        scope: "openid profile email offline_access grok-cli:access api:access",
        response: {
          device_code: "xai-device",
          user_code: "XAI",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 900,
          interval: 2,
        },
      },
      {
        provider: "radius",
        endpoint: "https://radius.pi.dev/v1/oauth/device",
        scope: "gateway offline_access",
        response: {
          device_code: "radius-device",
          user_code: "RADIUS",
          verification_uri: "https://radius.pi.dev/activate",
          expires_in: 900,
          interval: 1,
        },
      },
    ];

    for (const item of cases) {
      const calls = mockFetch([response(item.response)]);
      const flow = await startOAuthV1(
        item.provider,
        "attempt-state",
        undefined,
        1_000,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(item.endpoint);
      expect(calls[0]?.init?.method).toBe("POST");
      expect(fields(calls[0]!)).toMatchObject({
        client_id: expect.any(String),
        ...(item.scope ? { scope: item.scope } : {}),
      });
      expect(calls[0]?.init?.headers).toMatchObject({
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect(flow).toMatchObject({
        state: "attempt-state",
        expiresAt: 901_000,
        userCode: item.response.user_code,
      });
      expect(flow.authorizationUrl.startsWith("https://")).toBe(true);
    }

    const calls = mockFetch([]);
    const openrouter = await startOAuthV1(
      "openrouter",
      "attempt-state",
      "https://app.example/oauth/callback",
      1_000,
    );
    expect(calls).toHaveLength(0);
    expect(openrouter.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openrouter.callbackUrl).toBe(
      "https://app.example/oauth/callback?state=attempt-state",
    );
    const authorization = new URL(openrouter.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://openrouter.ai/auth",
    );
    expect(authorization.searchParams.get("callback_url")).toBe(
      openrouter.callbackUrl!,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  test("polls every flow using its provider-specific exchange", async () => {
    const now = 1_000_000;
    const ordinary: Array<{
      provider: "xai" | "radius";
      endpoint: string;
    }> = [
      { provider: "xai", endpoint: "https://auth.x.ai/oauth2/token" },
      {
        provider: "radius",
        endpoint: "https://radius.pi.dev/v1/oauth/token",
      },
    ];
    for (const item of ordinary) {
      const calls = mockFetch([
        response({
          access_token: `${item.provider}-access`,
          refresh_token: `${item.provider}-refresh`,
          expires_in: 120,
        }),
      ]);
      await expect(
        pollOAuthV1(item.provider, deviceFlow(item.provider), undefined, now),
      ).resolves.toEqual({
        access: `${item.provider}-access`,
        refresh: `${item.provider}-refresh`,
        expires: now + 120_000,
      });
      expect(calls[0]?.url).toBe(item.endpoint);
      expect(fields(calls[0]!)).toMatchObject({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "DEVICE-CODE",
      });
    }

    const openrouterFlow: OAuthFlowV1 = {
      authorizationUrl: "https://openrouter.ai/auth",
      callbackUrl: "https://app.example/oauth/callback",
      verifier: "pkce-verifier",
      state: "attempt-state",
      expiresAt: 2_000_000,
      intervalMs: 5_000,
    };
    const calls = mockFetch([response({ key: "openrouter-key" })]);
    await expect(
      pollOAuthV1(
        "openrouter",
        openrouterFlow,
        "https://app.example/oauth/callback?state=attempt-state&code=router-code",
        now,
      ),
    ).resolves.toEqual({
      access: "openrouter-key",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(fields(calls[0]!)).toEqual({
      code: "router-code",
      code_verifier: "pkce-verifier",
      code_challenge_method: "S256",
    });
  });

  test("refreshes every credential without losing retained refresh tokens", async () => {
    const now = 1_000_000;
    const current: OAuthTokenV1 = {
      access: "old-access",
      refresh: "old-refresh",
      expires: now - 1,
    };
    const ordinary: Array<{
      provider: "xai" | "radius";
      endpoint: string;
    }> = [
      { provider: "xai", endpoint: "https://auth.x.ai/oauth2/token" },
      {
        provider: "radius",
        endpoint: "https://radius.pi.dev/v1/oauth/token",
      },
    ];
    for (const item of ordinary) {
      const calls = mockFetch([
        response({ access_token: `${item.provider}-next`, expires_in: 60 }),
      ]);
      await expect(
        refreshOAuthV1(item.provider, current, now),
      ).resolves.toEqual({
        access: `${item.provider}-next`,
        refresh: "old-refresh",
        expires: now + 60_000,
      });
      expect(calls[0]?.url).toBe(item.endpoint);
      expect(fields(calls[0]!)).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
    }

    const calls = mockFetch([]);
    await expect(refreshOAuthV1("openrouter", current, now)).resolves.toBe(
      current,
    );
    expect(calls).toHaveLength(0);
  });

  test("binds the OpenRouter callback to its PKCE attempt", async () => {
    const flow = await startOAuthV1(
      "openrouter",
      "correct-state",
      "https://app.example/oauth/callback",
      1_000,
    );
    const calls = mockFetch([]);

    await expect(
      pollOAuthV1(
        "openrouter",
        flow,
        "https://app.example/oauth/callback?state=other-state&code=secret-code",
        2_000,
      ),
    ).rejects.toThrow("Sign-in callback does not match this attempt");
    await expect(
      pollOAuthV1(
        "openrouter",
        flow,
        "https://elsewhere.example/oauth/callback?state=correct-state&code=secret-code",
        2_000,
      ),
    ).rejects.toThrow("Sign-in callback does not match this attempt");
    expect(calls).toHaveLength(0);
  });

  test("reports pending, slow-down, and denied device authorization", async () => {
    for (const [body, expected] of [
      [{ error: "authorization_pending" }, "pending"],
      [{ error: "slow_down" }, "slow-down"],
    ] as const) {
      mockFetch([response(body, 400)]);
      await expect(
        pollOAuthV1("xai", deviceFlow("xai"), undefined, 1_000_000),
      ).resolves.toBe(expected);
    }

    mockFetch([
      response(
        {
          error: "access_denied",
          error_description: "denied while handling refresh-token-secret",
        },
        403,
      ),
    ]);
    const denied = await pollOAuthV1(
      "xai",
      deviceFlow("xai"),
      undefined,
      1_000_000,
    ).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(Error);
    expect((denied as Error).message).toBe(
      "OAuth request rejected (403); sign in again",
    );
    expect((denied as Error).message).not.toContain("refresh-token-secret");
  });

  test("round-trips encrypted-store payloads", () => {
    const credential: OAuthTokenV1 = {
      access: "access-secret",
      refresh: "refresh-secret",
      expires: 2_000_000,
    };
    expect(decodeOAuthTokenV1(encodeOAuthTokenV1(credential))).toEqual(
      credential,
    );
    expect(decodeOAuthTokenV1("ordinary-api-key")).toBeUndefined();
  });
});
