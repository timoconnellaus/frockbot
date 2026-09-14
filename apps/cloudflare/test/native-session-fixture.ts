import { env } from "cloudflare:test";
import {
  decodeProtocol,
  MINIMUM_NATIVE_VERSION,
} from "@frockbot/core/protocol-schemas";
import { decodeAccountAdmissionDecisionV1 } from "@frockbot/app/admin/shared";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../src/deployment-policy.ts";
import { createNativeAuth, NATIVE_RETURN_ANDROID } from "../src/native-auth.ts";

/** A verified identity in the identity store, as a Google sign-in leaves one. */
export async function seedNativeIdentity(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.AUTH_DB.prepare(
    'insert or ignore into "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(userId, "Native tester", `${userId}@native.test`, 1, null, now, now)
    .run();
}

/**
 * Gives `userId` what a real beta tester has: a verified identity and an
 * active access record in the deployment's authority. The deployed gateway
 * re-admits every native bearer through both, so a fixture that skipped them
 * would be testing a door production does not have.
 */
export async function grantNativeAccess(userId: string): Promise<void> {
  await seedNativeIdentity(userId);
  const authority = env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  );
  const current = await authority.readAccountAccess({
    schemaVersion: 1,
    userId,
  });
  if (current.access?.state === "active") return;
  const write = await authority.setAccountAccess({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "account/set-access",
      state: "active",
      revision: current.access?.revision ?? 0,
    },
    updatedBy: "native-session-fixture",
  });
  if (write.status !== "applied") throw new Error("Fixture access conflicted");
}

export async function nativeHeaders(userId: string) {
  await grantNativeAccess(userId);
  const owner = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
  const authority = env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  );
  // The identity-provider seam supplies a synthetic User; real PKCE signing,
  // durable issuance and the deployed gateway's bearer verification follow.
  const auth = createNativeAuth({
    secret: env.BETTER_AUTH_SECRET,
    returnUris: [NATIVE_RETURN_ANDROID],
    auth: {
      getSession: async () => ({
        user: { id: userId },
        session: { id: "browser-test" },
      }),
      handler: async () => new Response(null, { status: 404 }),
    },
    admit: async () =>
      decodeAccountAdmissionDecisionV1(
        await authority.admitAccount({
          schemaVersion: 1,
          userId,
          email: `${userId}@native.test`,
          emailVerified: true,
          isAdmin: false,
        }),
      ),
    session: async (_user, command) => {
      const result = await owner.nativeSession(command);
      if (result.status !== "ok") throw new Error("Fixture session refused");
      return result.record;
    },
  });
  const hello = {
    schemaVersion: 1,
    protocolVersion: 1,
    // The build the gateway currently accepts. Hard-coding a version made
    // every native test refuse itself the moment the minimum moved.
    nativeVersion: MINIMUM_NATIVE_VERSION,
    catalogs: [],
  };
  const verifier = "v".repeat(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const state = "s".repeat(32);
  const request = (path: string, body: unknown) =>
    new Request(`https://bot.frockbot.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frockbot-client": JSON.stringify(hello),
      },
      body: JSON.stringify(body),
    });
  const start = await auth.route(
    request("/api/auth/native/start", {
      schemaVersion: 1,
      commandId: "start-fixture",
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      returnUri: NATIVE_RETURN_ANDROID,
    }),
  );
  const view = decodeProtocol("AuthStartView", await start!.json());
  const redirect = await auth.route(new Request(view.authorizationUrl));
  const destination = new URL(redirect!.headers.get("location")!);
  const exchanged = await auth.route(
    request("/api/auth/native/exchange", {
      schemaVersion: 1,
      commandId: "exchange-fixture",
      code: destination.searchParams.get("code"),
      state,
      returnUri: NATIVE_RETURN_ANDROID,
      codeVerifier: verifier,
    }),
  );
  const session = decodeProtocol("AuthSessionView", await exchanged!.json());
  return {
    authorization: `Bearer ${session.sessionToken}`,
    "x-frockbot-client": JSON.stringify(hello),
  };
}
