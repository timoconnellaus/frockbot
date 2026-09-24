import { env, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  CLIENT_PROTOCOL_VERSION,
  decodeProtocol,
} from "@frockbot/core/protocol-schemas";
import { createAuth } from "@frockbot/app/auth/better-auth";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../../src/deployment-policy.ts";
import { nativeReturnUriV1 } from "../../src/native-auth.ts";

/** The origin `vitest.integration.config.ts` gives the Worker. */
const NATIVE_RETURN_ANDROID = nativeReturnUriV1(
  "https://bot.frockbot.com",
  "android",
);
import { ORIGIN, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/** A Google-created User and the browser cookie its session is signed into. */
async function browserUser(email: string) {
  const auth = createAuth(env);
  const adapter = (await auth.$context).internalAdapter;
  const user = await adapter.createUser(
    { name: "Native sign-in tester", email, emailVerified: true },
    { method: "oauth", oauth: { providerId: "google" } },
  );
  const session = await adapter.createSession(user.id);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = base64(
    await crypto.subtle.sign("HMAC", key, encoder.encode(session.token)),
  );
  return {
    user,
    headers: {
      cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
    },
  };
}

test("a signed-in browser is asked before native authorization issues a code, and only its own press is taken", async () => {
  const email = `native-${crypto.randomUUID()}@test.invalid`;
  const { user, headers: browserHeaders } = await browserUser(email);
  const encoder = new TextEncoder();
  const authority = env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  );
  expect(
    await authority.setAccountAccess({
      schemaVersion: 1,
      userId: user.id,
      command: {
        schemaVersion: 1,
        type: "account/set-access",
        state: "active",
        revision: 0,
      },
      updatedBy: "native-sign-in-test",
    }),
  ).toMatchObject({ status: "applied" });
  const identity = await SELF.fetch(`${ORIGIN}/api/identity`, {
    headers: browserHeaders,
  });
  expect(identity.status).toBe(200);

  const hello = {
    schemaVersion: 1,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    nativeVersion: "0.7.163",
    catalogs: [],
  };
  const verifier = "v".repeat(64);
  const state = "s".repeat(32);
  const challenge = base64(
    await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const post = (path: string, body: unknown) =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frockbot-client": JSON.stringify(hello),
      },
      body: JSON.stringify(body),
    });
  // The public start request must finish without leaving an unused auth
  // initialization behind that stalls the next request's session lookup.
  const start = await post("/api/auth/native/start", {
    schemaVersion: 1,
    commandId: "native-sign-in-start",
    state,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    returnUri: NATIVE_RETURN_ANDROID,
  });
  expect(start.status).toBe(200);
  const view = decodeProtocol("AuthStartView", await start.json());
  // The browser is signed in, and still no code leaves without a press: the
  // authorization and the page a fresh sign-in completes on both ask.
  let consent = "";
  for (const url of [
    view.authorizationUrl,
    view.authorizationUrl.replace("/native/authorize?", "/native/complete?"),
  ]) {
    const page = await SELF.fetch(url, {
      headers: browserHeaders,
      redirect: "manual",
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await page.text();
    expect(html).toContain(
      "Sign in to the FrockBot app on this Android device?",
    );
    expect(html).toContain(email);
    expect(html).not.toContain("code=");
    consent = /name="consent" value="([A-Za-z0-9_.-]+)"/.exec(html)![1]!;
  }
  const press = (headers: Record<string, string>) =>
    SELF.fetch(`${ORIGIN}/native/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ consent }).toString(),
      redirect: "manual",
    });
  const sameOrigin = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
  // A form on another site, a post that names no origin, another User's
  // browser and no browser session are all refused, and spend nothing.
  expect(
    (
      await press({
        ...browserHeaders,
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect((await press(browserHeaders)).status).toBe(403);
  const someoneElse = await browserUser(
    `native-${crypto.randomUUID()}@test.invalid`,
  );
  expect((await press({ ...someoneElse.headers, ...sameOrigin })).status).toBe(
    403,
  );
  expect((await press(sameOrigin)).status).toBe(401);
  const authorized = await press({ ...browserHeaders, ...sameOrigin });
  expect(authorized.status).toBe(303);
  const destination = new URL(authorized.headers.get("location")!);
  expect(destination.origin + destination.pathname).toBe(NATIVE_RETURN_ANDROID);
  expect(destination.searchParams.get("state")).toBe(state);
  const exchanged = await post("/api/auth/native/exchange", {
    schemaVersion: 1,
    commandId: "native-sign-in-exchange",
    code: destination.searchParams.get("code"),
    state,
    returnUri: NATIVE_RETURN_ANDROID,
    codeVerifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  const native = decodeProtocol("AuthSessionView", await exchanged.json());
  expect(native.userId).toBe(user.id);
  expect(
    (
      await SELF.fetch(`${ORIGIN}/api/identity`, {
        headers: {
          authorization: `Bearer ${native.sessionToken}`,
          "x-frockbot-client": JSON.stringify(hello),
        },
      })
    ).status,
  ).toBe(200);
});
