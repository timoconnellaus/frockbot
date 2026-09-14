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

test("a native bearer without a durable session cannot provision its User", async () => {
  // Real, verified identities — just not ones this deployment admitted. The
  // integration deployment's admission mode is the closed default.
  const unknown = freshUserId("native-unadmitted");
  const blocked = freshUserId("native-blocked");
  await seedNativeIdentity(unknown);
  await seedNativeIdentity(blocked);
  await setAccess(blocked, "blocked");

  for (const userId of [unknown, blocked]) {
    const response = await SELF.fetch(`${ORIGIN}/api/identity`, {
      headers: await signedBearer(userId),
    });
    expect(response.status).toBe(401);
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

test("sign-out while paused stays revoked after reactivation", async () => {
  const userId = freshUserId("native-paused-signout");
  const headers = await nativeHeaders(userId);
  await setAccess(userId, "paused");
  const response = await SELF.fetch(`${ORIGIN}/api/auth/native/revoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: "sign-out-paused",
      action: "sign-out",
      sessionId: "start-fixture",
    }),
  });
  expect(response.status).toBe(200);
  await setAccess(userId, "active");
  expect((await SELF.fetch(`${ORIGIN}/api/identity`, { headers })).status).toBe(
    401,
  );
});

test("reading or revoking a missing native session never provisions its User", async () => {
  const userId = freshUserId("native-missing-session");
  const owner = env.USER_CONFIGURATIONS.getByName(userId);
  for (const action of ["read", "revoke"] as const) {
    expect(
      await owner.nativeSession({
        schemaVersion: 1,
        action,
        userId,
        sessionId: "missing-session",
        expiresAt: Date.now() + 60_000,
        hello,
      }),
    ).toEqual({ schemaVersion: 1, status: "ok", record: null });
    expect(await provisioned(userId)).toBe(false);
  }
});

for (const mode of ["open", "invite-only"] as const) {
  test(`a revoked native bearer cannot grant access during ${mode} admission`, async () => {
    const userId = freshUserId("native-revoked-admission");
    const headers = await nativeHeaders(userId);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/auth/native/revoke`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            commandId: "sign-out-before-admission",
            action: "sign-out",
            sessionId: "start-fixture",
          }),
        })
      ).status,
    ).toBe(200);
    const authority = env.DEPLOYMENT_POLICY.getByName(
      DEPLOYMENT_POLICY_SINGLETON_NAME,
    );
    await runInDurableObject(authority, async (_instance, state) => {
      await state.storage.delete(`account:access:v1:${userId}`);
    });
    const setMode = async (mode: "open" | "invite-only" | "closed") => {
      const policy = await authority.readPolicy({ schemaVersion: 1 });
      expect(
        await authority.setAdmissionMode({
          schemaVersion: 1,
          command: {
            schemaVersion: 1,
            type: "deployment/set-admission-mode",
            revision: policy.revision,
            mode,
          },
          updatedBy: "native-access-test",
        }),
      ).toMatchObject({ status: "applied" });
    };
    await setMode(mode);
    if (mode === "invite-only") {
      await authority.inviteEmail({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "access/invite-email",
          email: `${userId}@native.test`,
        },
        invitedBy: "native-access-test",
      });
    }
    expect(
      (await SELF.fetch(`${ORIGIN}/api/identity`, { headers })).status,
    ).toBe(401);
    expect(
      await authority.readAccountAccess({ schemaVersion: 1, userId }),
    ).toMatchObject({ access: null });
    if (mode === "invite-only") {
      expect(
        await authority.mayCreateIdentity({
          schemaVersion: 1,
          email: `${userId}@native.test`,
          emailVerified: true,
          isAdmin: false,
        }),
      ).toBe(true);
    }
    await setMode("closed");
    expect(
      await authority.admitAccount({
        schemaVersion: 1,
        userId,
        email: `${userId}@native.test`,
        emailVerified: true,
        isAdmin: false,
      }),
    ).toMatchObject({ admitted: false, reason: "admission-closed" });
  });
}
