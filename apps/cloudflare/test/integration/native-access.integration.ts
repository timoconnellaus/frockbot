import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { MINIMUM_NATIVE_VERSION } from "@frockbot/core/protocol-schemas";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../../src/deployment-policy.ts";
import {
  nativeHeaders,
  seedNativeIdentity,
} from "../native-session-fixture.ts";
import { freshUserId, ORIGIN, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

const hello = {
  schemaVersion: 1,
  protocolVersion: 1,
  nativeVersion: MINIMUM_NATIVE_VERSION,
  catalogs: [],
};

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * A bearer the Worker would accept, for an identity that was never admitted.
 * Issuing one through the exchange would be refused first, so this is how a
 * test holds a bearer the authority must still refuse on use — the shape a
 * session issued before a pause, or before this authority existed, has.
 */
async function signedBearer(userId: string): Promise<Record<string, string>> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`frockbot-native-v1:${env.BETTER_AUTH_SECRET}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        kind: "session",
        userId,
        sessionId: `session-${crypto.randomUUID()}`,
        hello,
        expires: Date.now() + 3_600_000,
      }),
    ),
  );
  const signature = base64url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
    ),
  );
  return {
    authorization: `Bearer frockbot-native.${payload}.${signature}`,
    "x-frockbot-client": JSON.stringify(hello),
  };
}

async function provisioned(userId: string): Promise<boolean> {
  return runInDurableObject(
    env.USER_CONFIGURATIONS.getByName(userId),
    async (_instance, state) =>
      (await state.storage.get("user:identity")) !== undefined,
  );
}

async function setAccess(
  userId: string,
  state: "active" | "paused" | "blocked",
): Promise<void> {
  const authority = env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  );
  const current = await authority.readAccountAccess({
    schemaVersion: 1,
    userId,
  });
  const write = await authority.setAccountAccess({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "account/set-access",
      state,
      revision: current.access?.revision ?? 0,
    },
    updatedBy: "owner",
  });
  expect(write.status).toBe("applied");
}

test("a native bearer for an identity without access is refused before the User exists", async () => {
  // Real, verified identities — just not ones this deployment admitted. The
  // integration deployment's admission mode is the closed default.
  const unknown = freshUserId("native-unadmitted");
  const blocked = freshUserId("native-blocked");
  await seedNativeIdentity(unknown);
  await seedNativeIdentity(blocked);
  await setAccess(blocked, "blocked");

  for (const [userId, reason] of [
    [unknown, "admission-closed"],
    [blocked, "account-blocked"],
  ] as const) {
    const response = await SELF.fetch(`${ORIGIN}/api/identity`, {
      headers: await signedBearer(userId),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "account-access-refused",
      reason,
    });
    expect(await provisioned(userId)).toBe(false);
  }
});

test("pausing a native account refuses its live bearer on the next request, and resuming restores it", async () => {
  const userId = freshUserId("native-paused");
  const headers = await nativeHeaders(userId);
  const identity = () => SELF.fetch(`${ORIGIN}/api/identity`, { headers });

  expect((await identity()).status).toBe(200);
  await setAccess(userId, "paused");
  const refused = await identity();
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ reason: "account-paused" });
  await setAccess(userId, "active");
  expect((await identity()).status).toBe(200);
});
