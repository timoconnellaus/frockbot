import { expect, test } from "vitest";
import { createAuth } from "../../src/auth.ts";
import { env } from "cloudflare:test";
import { ORIGIN, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

const GOOGLE_WEB_CLIENT_ID = "test-web-client.apps.googleusercontent.com";

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fakeGoogleIdToken(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  return [
    base64UrlJson({ alg: "RS256", kid: "fake-key" }),
    base64UrlJson({
      iss: "https://accounts.google.com",
      aud: GOOGLE_WEB_CLIENT_ID,
      sub: subject,
      email: `${subject}@example.com`,
      email_verified: true,
      name: "Native Android User",
      picture: "https://example.com/avatar.png",
      iat: now,
      exp: now + 600,
      nonce: "native-nonce",
    }),
    "fake-signature",
  ].join(".");
}

test("the Google ID-token endpoint creates a hosted Better Auth session", async () => {
  const acceptedToken = fakeGoogleIdToken(`android-${crypto.randomUUID()}`);
  const verificationCalls: Array<{
    token: string;
    audience: string | string[];
    nonce?: string;
  }> = [];
  const auth = createAuth(
    {
      AUTH_DB: env.AUTH_DB,
      BETTER_AUTH_SECRET: "integration-better-auth-secret-for-native-google",
      BETTER_AUTH_URL: ORIGIN,
      GOOGLE_CLIENT_ID: GOOGLE_WEB_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "integration-google-client-secret",
    },
    {
      verifyGoogleIdToken: (options) => {
        verificationCalls.push(options);
        return Promise.resolve(options.token === acceptedToken ? {} : null);
      },
    },
  );

  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        provider: "google",
        idToken: { token: acceptedToken, nonce: "native-nonce" },
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.clone().json()).toMatchObject({ redirect: false });
  expect(verificationCalls).toEqual([
    {
      token: acceptedToken,
      audience: GOOGLE_WEB_CLIENT_ID,
      nonce: "native-nonce",
    },
  ]);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("better-auth.session_token=");

  const session = await auth.handler(
    new Request(`${ORIGIN}/api/auth/get-session`, {
      headers: { cookie: setCookie!.split(";", 1)[0]! },
    }),
  );
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({
    user: { email: expect.stringMatching(/^android-.+@example\.com$/) },
  });

  const rejected = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        provider: "google",
        idToken: { token: "rejected", nonce: "native-nonce" },
      }),
    }),
  );
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("set-cookie")).toBeNull();
});
