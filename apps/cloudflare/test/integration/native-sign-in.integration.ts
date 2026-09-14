import { env, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  decodeProtocol,
  MINIMUM_NATIVE_VERSION,
} from "@frockbot/core/protocol-schemas";
import { createAuth } from "../../src/auth.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../../src/deployment-policy.ts";
import { NATIVE_RETURN_ANDROID } from "../../src/native-auth.ts";
import { ORIGIN, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

test("a browser session completes native start, authorization and exchange", async () => {
  const auth = createAuth(env);
  const adapter = (await auth.$context).internalAdapter;
  const user = await adapter.createUser(
    {
      name: "Native sign-in tester",
      email: `native-${crypto.randomUUID()}@test.invalid`,
      emailVerified: true,
    },
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
  const browserHeaders = {
    cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
  };
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
    protocolVersion: 1,
    nativeVersion: MINIMUM_NATIVE_VERSION,
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
  const authorized = await SELF.fetch(view.authorizationUrl, {
    headers: browserHeaders,
    redirect: "manual",
  });
  expect(authorized.status).toBe(302);
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
