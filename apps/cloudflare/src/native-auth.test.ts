import { decodeProtocol } from "@frockbot/protocol-schemas";
import { describe, expect, test } from "bun:test";
import {
  createNativeAuth,
  NATIVE_ORIGIN,
  NATIVE_RETURN_ANDROID,
} from "./native-auth.js";
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
function fixture() {
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
