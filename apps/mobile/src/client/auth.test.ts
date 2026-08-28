import { describe, expect, test } from "bun:test";
import {
  AUTH_TOKEN_KEY,
  createAuthSession,
  DEVELOPMENT_USER_KEY,
  GATEWAY_URL_KEY,
  normalizeGatewayUrl,
  UnauthorizedError,
} from "./auth.ts";
import { createMemoryPreferenceStore } from "./preferences.ts";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function createFetch(responder: (request: RecordedRequest) => Response): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const request = { url, init };
      calls.push(request);
      return Promise.resolve(responder(request));
    },
  };
}

describe("normalizeGatewayUrl", () => {
  test("strips trailing slashes and keeps the path", () => {
    expect(normalizeGatewayUrl(" https://gateway.example.com/ ")).toBe(
      "https://gateway.example.com",
    );
    expect(normalizeGatewayUrl("http://127.0.0.1:8787/base/")).toBe(
      "http://127.0.0.1:8787/base",
    );
  });

  test("rejects values that are not absolute http(s) URLs", () => {
    expect(() => normalizeGatewayUrl("")).toThrow(
      "gateway URL must not be empty",
    );
    expect(() => normalizeGatewayUrl("gateway.example.com")).toThrow(
      "gateway URL must be an absolute http(s) URL",
    );
    expect(() => normalizeGatewayUrl("capacitor://localhost")).toThrow(
      "gateway URL must be an absolute http(s) URL",
    );
  });
});

describe("token store", () => {
  test("restores a persisted session", async () => {
    const store = createMemoryPreferenceStore({
      [GATEWAY_URL_KEY]: "https://gateway.example.com/",
      [AUTH_TOKEN_KEY]: "stored-token",
      [DEVELOPMENT_USER_KEY]: "  ",
    });
    const auth = createAuthSession({
      store,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    expect(await auth.load()).toEqual({
      gatewayUrl: "https://gateway.example.com",
      token: "stored-token",
      developmentUserId: undefined,
    });
  });

  test("discards a stored gateway URL that no longer decodes", async () => {
    const store = createMemoryPreferenceStore({
      [GATEWAY_URL_KEY]: "not-a-url",
    });
    const auth = createAuthSession({
      store,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      defaultGatewayUrl: "https://fallback.example.com",
    });

    expect((await auth.load()).gatewayUrl).toBe("https://fallback.example.com");
    expect(await store.get(GATEWAY_URL_KEY)).toBeNull();
  });

  test("signing out clears the token and development identity", async () => {
    const store = createMemoryPreferenceStore();
    const auth = createAuthSession({
      store,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setToken("token");
    await auth.setDevelopmentUserId("development");

    await auth.signOut();

    expect(auth.state().token).toBeUndefined();
    expect(await store.get(AUTH_TOKEN_KEY)).toBeNull();
    expect(await store.get(DEVELOPMENT_USER_KEY)).toBeNull();
  });
});

describe("authorizedFetch", () => {
  test("sends the bearer token and omits credentials", async () => {
    const transport = createFetch(() => new Response("{}", { status: 200 }));
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setToken("token-1");

    await auth.authorizedFetch("/api/bots/default/turns", {
      method: "POST",
      body: "{}",
    });

    const call = transport.calls[0];
    expect(call?.url).toBe(
      "https://gateway.example.com/api/bots/default/turns",
    );
    expect(call?.init?.credentials).toBe("omit");
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("adds the development user query when no token is held", async () => {
    const transport = createFetch(() => new Response("{}", { status: 200 }));
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setDevelopmentUserId("development");

    await auth.authorizedFetch("/api/bots/default/turns");

    expect(transport.calls[0]?.url).toBe(
      "https://gateway.example.com/api/bots/default/turns?as_user=development",
    );
    expect(
      new Headers(transport.calls[0]?.init?.headers).has("authorization"),
    ).toBe(false);
  });

  test("persists a token issued through the set-auth-token header", async () => {
    const store = createMemoryPreferenceStore();
    const transport = createFetch(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "set-auth-token": "issued-token" },
        }),
    );
    const auth = createAuthSession({
      store,
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });

    await auth.authorizedFetch("/api/bots/default/turns");

    expect(auth.state().token).toBe("issued-token");
    expect(await store.get(AUTH_TOKEN_KEY)).toBe("issued-token");
  });

  test("clears state and notifies listeners on 401", async () => {
    const store = createMemoryPreferenceStore();
    const transport = createFetch(
      () => new Response(JSON.stringify({ error: "x" }), { status: 401 }),
    );
    const auth = createAuthSession({
      store,
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setToken("expired");
    let notifications = 0;
    const release = auth.onUnauthorized(() => {
      notifications += 1;
    });

    let failure: unknown;
    try {
      await auth.authorizedFetch("/api/bots/default/turns");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UnauthorizedError);
    expect(auth.state().token).toBeUndefined();
    expect(await store.get(AUTH_TOKEN_KEY)).toBeNull();
    expect(notifications).toBe(1);
    release();
  });

  test("requires a configured gateway and an absolute path", async () => {
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: () => Promise.resolve(new Response(null)),
    });

    expect(auth.authorizedFetch("/api/bots/default/turns")).rejects.toThrow(
      "gateway URL is not configured",
    );
    await auth.setGatewayUrl("https://gateway.example.com");
    expect(auth.authorizedFetch("api/bots")).rejects.toThrow(
      "request path must start with /",
    );
  });
});

describe("probe", () => {
  test("reports false without any credential", async () => {
    const transport = createFetch(() => new Response("{}", { status: 200 }));
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });

    expect(await auth.probe("default")).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  test("reports false when the gateway rejects the token", async () => {
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setToken("expired");

    expect(await auth.probe("default")).toBe(false);
  });

  test("reports true when the gateway accepts the token", async () => {
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ schemaVersion: 1, runs: [] }), {
            status: 200,
          }),
        ),
      defaultGatewayUrl: "https://gateway.example.com",
    });
    await auth.setToken("valid");

    expect(await auth.probe("default")).toBe(true);
  });
});

describe("startGoogleSignIn", () => {
  test("returns the provider redirect URL", async () => {
    const transport = createFetch(
      () =>
        new Response(JSON.stringify({ url: "https://accounts.google.com/x" }), {
          status: 200,
        }),
    );
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: transport.fetch,
      defaultGatewayUrl: "https://gateway.example.com",
    });

    expect(await auth.startGoogleSignIn("https://gateway.example.com/")).toBe(
      "https://accounts.google.com/x",
    );
    expect(transport.calls[0]?.url).toBe(
      "https://gateway.example.com/api/auth/sign-in/social",
    );
  });

  test("rejects a response without a redirect URL", async () => {
    const auth = createAuthSession({
      store: createMemoryPreferenceStore(),
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
      defaultGatewayUrl: "https://gateway.example.com",
    });

    expect(
      auth.startGoogleSignIn("https://gateway.example.com/"),
    ).rejects.toThrow("sign-in response did not carry a redirect URL");
  });
});
