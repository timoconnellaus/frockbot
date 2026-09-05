import { decodeProtocol } from "@frockbot/protocol-schemas";
import { describe, expect, test } from "bun:test";
import {
  createNativeAuth,
  readNativeJsonBody,
  NATIVE_ORIGIN,
  NATIVE_RETURN_ANDROID,
  NATIVE_RETURN_MACOS,
  nativeReturnUris,
  type NativeAuthOptions,
} from "./native-auth.js";
import { createGateway } from "./gateway.js";
import {
  nativeSessionOperation,
  type NativeSessionStorage,
} from "./native-sessions.js";

const hello = {
  schemaVersion: 1,
  protocolVersion: 1,
  nativeVersion: "1.1.0",
  catalogs: [],
};
const verifier = "a".repeat(64);
const state = "b".repeat(64);
const challenge = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
).toString("base64url");
function fixture(overrides: Partial<NativeAuthOptions> = {}) {
  let time = Date.parse("2026-09-05T01:00:00Z");
  const values = new Map<string, unknown>();
  const storage: NativeSessionStorage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
  const auth = createNativeAuth({
    secret: "test-only-secret-that-is-not-a-credential",
    returnUris: [NATIVE_RETURN_ANDROID],
    canIssueSession: async () => true,
    now: () => time,
    auth: {
      handler: async () =>
        Response.json(
          { url: "https://accounts.google.com/o/oauth2/v2/auth?test=true" },
          {
            headers: { "set-cookie": "test-state=synthetic; Secure; HttpOnly" },
          },
        ),
      getSession: async (headers) =>
        headers.get("cookie") === "test=signed-in"
          ? { user: { id: "user-1" } }
          : null,
    },
    session: async (_user, input) =>
      nativeSessionOperation(storage, input, time),
    ...overrides,
  });
  function request(
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Request(`${NATIVE_ORIGIN}${path}`, {
      method: data ? "POST" : "GET",
      headers: { "x-frockbot-client": JSON.stringify(hello), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }
  const start = {
    schemaVersion: 1,
    commandId: "sign-in-1",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    returnUri: NATIVE_RETURN_ANDROID,
  };
  async function authorize() {
    const response = await auth.route(request("/api/auth/native/start", start));
    expect(response?.status).toBe(200);
    const view = decodeProtocol("AuthStartView", await response!.json());
    const returned = await auth.route(
      new Request(view.authorizationUrl, {
        headers: { cookie: "test=signed-in" },
      }),
    );
    expect(returned?.status).toBe(302);
    const destination = new URL(returned!.headers.get("location")!);
    expect(destination.origin + destination.pathname).toBe(
      NATIVE_RETURN_ANDROID,
    );
    return {
      schemaVersion: 1,
      commandId: "exchange-1",
      code: destination.searchParams.get("code"),
      state,
      returnUri: NATIVE_RETURN_ANDROID,
      codeVerifier: verifier,
    };
  }
  return {
    auth,
    request,
    start,
    authorize,
    values,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("native system browser exchange", () => {
  test("one exchange durably issues a bound session; replay and revocation fail closed", async () => {
    const f = fixture();
    const command = await f.authorize();
    const response = await f.auth.route(
      f.request("/api/auth/native/exchange", command),
    );
    expect(response?.status).toBe(200);
    const session = decodeProtocol("AuthSessionView", await response!.json());
    expect(f.values.size).toBe(1);
    const headers = { authorization: `Bearer ${session.sessionToken}` };
    expect(
      (
        await f.auth.authenticate(
          f.request("/api/identity", undefined, headers),
        )
      )?.session?.user.id,
    ).toBe("user-1");
    expect(
      (await f.auth.route(f.request("/api/auth/native/exchange", command)))
        ?.status,
    ).toBe(400);
    expect(
      (
        await f.auth.route(
          f.request(
            "/api/auth/native/revoke",
            {
              schemaVersion: 1,
              commandId: "sign-out-1",
              action: "sign-out",
              sessionId: session.sessionId,
            },
            headers,
          ),
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await f.auth.authenticate(
          f.request("/api/identity", undefined, headers),
        )
      )?.session,
    ).toBeNull();
    expect(
      (await f.auth.route(f.request("/api/auth/native/exchange", command)))
        ?.status,
    ).toBe(400);
  });
  test.each([
    "https://evil.test/return",
    `${NATIVE_RETURN_ANDROID}/extra`,
    "com.frockbot.mobile:/callback",
    `${NATIVE_RETURN_ANDROID}?next=evil`,
    "https://bot.frockbot.com.evil.test/native/return/android",
  ])("rejects return %s", async (returnUri) => {
    const f = fixture();
    expect(
      (
        await f.auth.route(
          f.request("/api/auth/native/start", { ...f.start, returnUri }),
        )
      )?.status,
    ).toBe(400);
    expect(f.values.size).toBe(0);
  });
  test.each(["codeVerifier", "state", "returnUri", "code"])(
    "rejects mismatched %s without consuming authorization",
    async (field) => {
      const f = fixture();
      const command = await f.authorize();
      expect(
        (
          await f.auth.route(
            f.request("/api/auth/native/exchange", {
              ...command,
              [field]: "z".repeat(64),
            }),
          )
        )?.status,
      ).toBe(400);
      expect(f.values.size).toBe(0);
      expect(
        (await f.auth.route(f.request("/api/auth/native/exchange", command)))
          ?.status,
      ).toBe(200);
    },
  );
  test("Google redirect retains Better Auth state cookie and callback needs browser identity", async () => {
    const f = fixture();
    const response = await f.auth.route(
      f.request("/api/auth/native/start", f.start),
    );
    const view = decodeProtocol("AuthStartView", await response!.json());
    const google = await f.auth.route(new Request(view.authorizationUrl));
    expect(new URL(google!.headers.get("location")!).hostname).toBe(
      "accounts.google.com",
    );
    expect(google!.headers.get("set-cookie")).toContain("test-state=");
    expect(
      (
        await f.auth.route(
          new Request(view.authorizationUrl.replace("/authorize", "/complete")),
        )
      )?.status,
    ).toBe(401);
    expect(f.values.size).toBe(0);
  });
  test("authorization expiry and missing/changed hello block issuance and reconnect", async () => {
    const f = fixture();
    const command = await f.authorize();
    f.advance(300001);
    expect(
      (await f.auth.route(f.request("/api/auth/native/exchange", command)))
        ?.status,
    ).toBe(400);
    const g = fixture();
    const valid = await g.authorize();
    const response = await g.auth.route(
      g.request("/api/auth/native/exchange", valid),
    );
    const session = decodeProtocol("AuthSessionView", await response!.json());
    for (const value of [
      "",
      JSON.stringify({ ...hello, nativeVersion: "1.0.0" }),
      JSON.stringify({ ...hello, nativeVersion: "1.2.0" }),
    ]) {
      const result = await g.auth.authenticate(
        g.request("/api/bots/bot-1/state-channel", undefined, {
          authorization: `Bearer ${session.sessionToken}`,
          "x-frockbot-client": value,
        }),
      );
      expect(result?.refusal?.status).toBe(426);
    }
  });
});

test("deployment targets are an exact fail-closed switch", () => {
  expect(nativeReturnUris("android")).toEqual([NATIVE_RETURN_ANDROID]);
  expect(nativeReturnUris("android,macos")).toEqual([
    NATIVE_RETURN_ANDROID,
    NATIVE_RETURN_MACOS,
  ]);
  for (const value of [
    undefined,
    "",
    "true",
    "macos",
    "android, macos",
    "android,ios",
  ])
    expect(nativeReturnUris(value)).toEqual([]);
});

function gateway(nativeAuth?: ReturnType<typeof createNativeAuth>) {
  const unexpected = (): never => {
    throw new Error("Application must not load");
  };
  return {
    fetch: createGateway({
      ...(nativeAuth ? { nativeAuth } : {}),
      auth: {
        getSession: async () => null,
        handler: async () => new Response("browser auth"),
      },
      loader: { get: unexpected },
      artifacts: { load: unexpected },
      userExists: unexpected,
      readDeploymentPolicy: unexpected,
      applicationHashFor: unexpected,
      botStateFor: unexpected,
      userConfigurationFor: unexpected,
      botConfigurationFor: unexpected,
    }),
  };
}

test("gateway serves public associations and exact returns without loading Vue; disabled routes never fall through", async () => {
  const f = fixture();
  const enabled = gateway(f.auth);
  const disabled = gateway();
  for (const path of [
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
    "/native/return/android",
  ]) {
    const response = await enabled.fetch(f.request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect((await disabled.fetch(f.request(path))).status).toBe(503);
  }
  expect(
    (await disabled.fetch(f.request("/api/auth/native/start", f.start))).status,
  ).toBe(503);
  expect(
    await (await disabled.fetch(f.request("/api/auth/get-session"))).text(),
  ).toBe("browser auth");
  for (const target of [
    NATIVE_RETURN_MACOS,
    `${NATIVE_RETURN_ANDROID}/extra`,
    `${NATIVE_RETURN_ANDROID}?next=evil`,
    `${NATIVE_RETURN_ANDROID}#fragment`,
    NATIVE_RETURN_ANDROID.replace("https:", "http:"),
  ]) {
    expect(
      (
        await enabled.fetch(
          f.request("/api/auth/native/start", {
            ...f.start,
            returnUri: target,
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await enabled.fetch(
        new Request("https://evil.test/.well-known/assetlinks.json"),
      )
    ).status,
  ).toBe(403);
  // Google's verifier fetches the fully qualified host, and some fetchers
  // probe with HEAD first; both must see the same public statement.
  const qualified = await enabled.fetch(
    new Request("https://bot.frockbot.com./.well-known/assetlinks.json"),
  );
  expect(qualified.status).toBe(200);
  expect(await qualified.text()).toContain("com.frockbot.mobile");
  const head = await enabled.fetch(
    new Request("https://bot.frockbot.com/.well-known/assetlinks.json", {
      method: "HEAD",
    }),
  );
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(
    (
      await enabled.fetch(
        new Request("https://evil.test./.well-known/assetlinks.json", {
          method: "HEAD",
        }),
      )
    ).status,
  ).toBe(403);
});

test("gateway concurrent exchange replay issues exactly one session", async () => {
  const f = fixture();
  const command = await f.authorize();
  const g = gateway(f.auth);
  const replies = await Promise.all(
    [1, 2].map(() => g.fetch(f.request("/api/auth/native/exchange", command))),
  );
  expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(f.values.size).toBe(1);
});

test("failed durable issuance cannot return a bearer", async () => {
  const f = fixture({ session: async () => null });
  const response = await gateway(f.auth).fetch(
    f.request("/api/auth/native/exchange", await f.authorize()),
  );
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("sessionToken");
});

test("closed or unavailable signup policy refuses before User provisioning", async () => {
  for (const unavailable of [false, true]) {
    const f = fixture({
      canIssueSession: async () => {
        if (unavailable) throw new Error("Policy unavailable");
        return false;
      },
    });
    const response = await gateway(f.auth).fetch(
      f.request("/api/auth/native/exchange", await f.authorize()),
    );
    expect(response.status).toBe(unavailable ? 400 : 403);
    expect(f.values.size).toBe(0);
  }
});

test.each([
  "http://accounts.google.com/auth",
  "https://accounts.google.com:444/auth",
  "https://accounts.google.com.evil.test/auth",
  "https://user@accounts.google.com/auth",
])("gateway refuses provider redirect %s", async (url) => {
  const f = fixture({
    auth: {
      getSession: async () => null,
      handler: async () => Response.json({ url }),
    },
  });
  const g = gateway(f.auth);
  const view = decodeProtocol(
    "AuthStartView",
    await (await g.fetch(f.request("/api/auth/native/start", f.start))).json(),
  );
  const response = await g.fetch(new Request(view.authorizationUrl));
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
});

test("ambiguous browser callbacks are refused before identity resolution", async () => {
  const f = fixture();
  const view = decodeProtocol(
    "AuthStartView",
    await (await f.auth.route(
      f.request("/api/auth/native/start", f.start),
    ))!.json(),
  );
  for (const suffix of ["&request=other", "&next=https://evil.test"]) {
    expect(
      (
        await gateway(f.auth).fetch(
          new Request(view.authorizationUrl + suffix, {
            headers: { cookie: "test=signed-in" },
          }),
        )
      ).status,
    ).toBe(400);
  }
});

test("native Applet token transport rejects ambiguous or URL credentials", async () => {
  const { appletViewerTokenFromRequest } = await import("./gateway.js");
  const url = new URL(
    "https://bot.frockbot.com/api/applets/user.counter/socket",
  );
  const request = (protocols: string) =>
    new Request(url, { headers: { "sec-websocket-protocol": protocols } });
  expect(
    appletViewerTokenFromRequest(
      request("frockbot.applet.v1, frockbot.viewer.synthetic"),
      url,
    ),
  ).toBe("synthetic");
  expect(
    appletViewerTokenFromRequest(request("frockbot.viewer.synthetic"), url),
  ).toBeNull();
  expect(
    appletViewerTokenFromRequest(
      request("frockbot.applet.v1, frockbot.viewer.a, frockbot.viewer.b"),
      url,
    ),
  ).toBeNull();
  url.searchParams.set("token", "other");
  expect(
    appletViewerTokenFromRequest(
      request("frockbot.applet.v1, frockbot.viewer.synthetic"),
      url,
    ),
  ).toBeNull();
});

test("verified return associations name the existing Android signer and exact macOS path", async () => {
  const f = fixture();
  const android = await f.auth.route(f.request("/.well-known/assetlinks.json"));
  const apple = await f.auth.route(
    f.request("/.well-known/apple-app-site-association"),
  );
  expect(await android!.text()).toContain(
    "61:E6:47:9F:9C:57:55:15:4C:1F:93:9C:DE:48:E8:A7:57:EF:F3:13:6E:54:ED:1D:DA:5F:61:E7:8B:3C:1E:37",
  );
  expect(await apple!.text()).toContain("Q444L76529.com.frockbot.mobile");
});

describe("native provider setup navigation", () => {
  async function handoff(f: ReturnType<typeof fixture>, home = "models") {
    const exchange = await f.authorize();
    const response = await f.auth.route(
      f.request("/api/auth/native/exchange", exchange),
    );
    const session = decodeProtocol("AuthSessionView", await response!.json());
    const headers = { authorization: `Bearer ${session.sessionToken}` };
    const start = await f.auth.route(
      f.request(
        "/api/auth/native/settings",
        { schemaVersion: 1, home },
        headers,
      ),
    );
    expect(start?.status).toBe(200);
    expect(start?.headers.get("cache-control")).toContain("no-store");
    const view = decodeProtocol("AuthStartView", await start!.json());
    expect(view.authorizationUrl).not.toContain(session.sessionToken);
    return { view, headers, session };
  }
  test.each(["models", "connections"])(
    "returns only to the exact %s home for the same browser User",
    async (home) => {
      const f = fixture();
      const { view } = await handoff(f, home);
      const response = await f.auth.route(
        new Request(view.authorizationUrl, {
          headers: { cookie: "test=signed-in" },
        }),
      );
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe(
        `${NATIVE_ORIGIN}/?settings=${home}${home === "models" ? "#user-model-providers" : ""}`,
      );
      expect(response?.headers.get("set-cookie")).toBeNull();
      expect(f.values.size).toBe(1);
      for (const url of [
        view.authorizationUrl + "&next=https://evil.test",
        view.authorizationUrl + "&request=duplicate",
        view.authorizationUrl.replace(/.$/, "x"),
      ]) {
        expect(
          (
            await f.auth.route(
              new Request(url, { headers: { cookie: "test=signed-in" } }),
            )
          )?.status,
        ).toBe(400);
      }
      f.advance(300_001);
      expect(
        (await f.auth.route(new Request(view.authorizationUrl)))?.status,
      ).toBe(400);
    },
  );
  test("a different browser User is refused and absent browser auth cannot be replaced by the native bearer", async () => {
    let browserUser = "user-1";
    const returns: string[] = [];
    const f = fixture({
      auth: {
        getSession: async (headers) =>
          headers.has("cookie") ? { user: { id: browserUser } } : null,
        handler: async (request) => {
          const body = (await request.json()) as { callbackURL: string };
          returns.push(body.callbackURL);
          return Response.json({
            url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
          });
        },
      },
    });
    const { view, headers } = await handoff(f);
    browserUser = "other-user";
    expect(
      (
        await f.auth.route(
          new Request(view.authorizationUrl, {
            headers: { cookie: "signed-in" },
          }),
        )
      )?.status,
    ).toBe(403);
    const signIn = await f.auth.route(
      new Request(view.authorizationUrl, { headers }),
    );
    expect(signIn?.status).toBe(302);
    expect(returns).toEqual([view.authorizationUrl]);
    expect(f.values.size).toBe(1);
  });
  test("a missing/revoked bearer, incompatible client or arbitrary destination cannot mint a handoff", async () => {
    const f = fixture();
    const { headers, session } = await handoff(f);
    for (const body of [
      { schemaVersion: 1, home: "https://evil.test" },
      { schemaVersion: 1, home: "models", returnUri: "https://evil.test" },
    ]) {
      expect(
        (
          await f.auth.route(
            f.request("/api/auth/native/settings", body, headers),
          )
        )?.status,
      ).toBe(400);
    }
    expect(
      (
        await f.auth.route(
          f.request("/api/auth/native/settings", {
            schemaVersion: 1,
            home: "models",
          }),
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await f.auth.route(
          f.request(
            "/api/auth/native/settings",
            { schemaVersion: 1, home: "models" },
            {
              ...headers,
              "x-frockbot-client": JSON.stringify({
                ...hello,
                protocolVersion: 99,
              }),
            },
          ),
        )
      )?.status,
    ).toBe(426);
    await f.auth.route(
      f.request(
        "/api/auth/native/revoke",
        {
          schemaVersion: 1,
          commandId: "sign-out-settings",
          action: "sign-out",
          sessionId: session.sessionId,
        },
        headers,
      ),
    );
    expect(
      (
        await f.auth.route(
          f.request(
            "/api/auth/native/settings",
            { schemaVersion: 1, home: "models" },
            headers,
          ),
        )
      )?.status,
    ).toBe(401);
  });
});

test("settings input is byte- and depth-bounded before JSON decoding", async () => {
  const request = (body: string) =>
    new Request(NATIVE_ORIGIN, { method: "POST", body });
  const exact = JSON.stringify({
    text: 'quoted \" {[[]]}',
    value: "x".repeat(9_000),
  });
  expect(await readNativeJsonBody(request(exact), 512_000)).toEqual(
    JSON.parse(exact),
  );
  await expect(readNativeJsonBody(request(exact))).rejects.toThrow(
    "Too much input",
  );
  await expect(
    readNativeJsonBody(request("[".repeat(17) + "0" + "]".repeat(17)), 512_000),
  ).rejects.toThrow("nesting limit");
  await expect(
    readNativeJsonBody(request(JSON.stringify("🐑".repeat(10))), 20),
  ).rejects.toThrow("Too much input");
});
