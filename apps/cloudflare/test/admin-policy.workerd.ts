import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  createAdminBackendContribution,
  type AdminGatewayHost,
} from "@frockbot/app/admin/backend";
import {
  decodeAdminUserListViewV1,
  decodeDeploymentPolicyV1,
  decodeUserFeaturesV1,
  isUserFeaturesUnavailable,
  type DeploymentPolicyV1,
  type SetSignupsCommandV1,
  type SetUserFeaturesCommandV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";
import type {
  BotConfigurationBinding,
  GatewayAuth,
  UserBotStateBinding,
  UserConfigurationBinding,
  WorkerLoader,
} from "../src/contracts.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../src/deployment-policy.ts";
import { createGateway, SIGNUPS_CLOSED_MESSAGE } from "../src/gateway.ts";

interface PolicyRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setSignups(input: unknown): Promise<unknown>;
}

interface UserRpc {
  isProvisioned(input: unknown): Promise<boolean>;
  readConfiguration(input: unknown): Promise<unknown>;
  readFeatures(input: unknown): Promise<unknown>;
  setFeatures(input: unknown): Promise<unknown>;
}

function policyStub(): PolicyRpc {
  return env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  ) as unknown as PolicyRpc;
}

function userStub(userId: string): UserRpc {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserRpc;
}

async function readPolicy(): Promise<DeploymentPolicyV1> {
  return decodeDeploymentPolicyV1(
    await policyStub().readPolicy({ schemaVersion: 1 }),
  );
}

async function setSignups(
  command: SetSignupsCommandV1,
  updatedBy: string,
): Promise<DeploymentPolicyV1> {
  return decodeDeploymentPolicyV1(
    await policyStub().setSignups({
      schemaVersion: 1,
      command,
      updatedBy,
    }),
  );
}

async function readFeatures(userId: string): Promise<UserFeaturesV1> {
  return decodeUserFeaturesV1(
    await userStub(userId).readFeatures({ schemaVersion: 1, userId }),
  );
}

async function setFeatures(
  userId: string,
  command: SetUserFeaturesCommandV1,
  updatedBy: string,
): Promise<UserFeaturesV1> {
  return decodeUserFeaturesV1(
    await userStub(userId).setFeatures({
      schemaVersion: 1,
      userId,
      command,
      updatedBy,
    }),
  );
}

const auth: GatewayAuth = {
  handler: () => Promise.resolve(Response.json({ success: true })),
  getSession: (headers) => {
    const id = headers.get("x-test-user");
    if (!id) return Promise.resolve(null);
    const email = headers.get("x-test-email");
    return Promise.resolve({
      user: { id, ...(email ? { email } : {}) },
    });
  },
};

const loader: WorkerLoader = {
  get: () => ({
    getEntrypoint: () => ({
      fetch: () => Promise.resolve(new Response("admitted")),
    }),
  }),
};

function signedInRequest(
  path: string,
  identity: { id: string; email: string },
  init?: RequestInit,
): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-test-user", identity.id);
  headers.set("x-test-email", identity.email);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

function testGateway(
  listed: Array<{ userId: string; email: string; name: string }> = [],
  /** Accounts whose User Durable Object read fails, as an outage would. */
  unreadable: ReadonlySet<string> = new Set(),
) {
  const policyHost: AdminGatewayHost = {
    readDeploymentPolicy: readPolicy,
    setDeploymentSignups: setSignups,
    listUsers: () => Promise.resolve(listed),
    readUserFeatures: (userId) =>
      unreadable.has(userId)
        ? Promise.reject(new Error("Durable Object reset while responding"))
        : readFeatures(userId),
    setUserFeatures: setFeatures,
    readUserBilling: () =>
      Promise.resolve({
        includedMicros: 0,
        purchasedMicros: 0,
        complimentaryMicros: 0,
        reservedMicros: 0,
        subscribed: false,
        canSpend: false,
        suspended: false,
      }),
    grantUserCredit: () => Promise.reject(new Error("not under test")),
  };
  return createGateway({
    loader,
    artifacts: { load: () => Promise.resolve("export default {}") },
    auth,
    userExists: (userId) =>
      userStub(userId).isProvisioned({ schemaVersion: 1, userId }),
    readDeploymentPolicy: readPolicy,
    adminEmails: "owner@example.com",
    applicationHashFor: async (userId) => {
      await userStub(userId).readConfiguration({ schemaVersion: 1, userId });
      return "foundation-v1";
    },
    botStateFor: () => ({}) as UserBotStateBinding,
    userConfigurationFor: () => ({}) as UserConfigurationBinding,
    botConfigurationFor: () => ({}) as BotConfigurationBinding,
    backendContributions: [createAdminBackendContribution(policyHost)],
    allowDevelopmentIdentity: false,
  });
}

describe("deployment signup policy in workerd", () => {
  test("defaults closed, enforces admin writes, and gates only first-time Users", async () => {
    const gateway = testGateway();
    const owner = { id: "owner", email: "owner@example.com" };
    const newcomer = {
      id: `new-${crypto.randomUUID()}`,
      email: "new@example.com",
    };

    const initial = await readPolicy();
    expect(initial.signups.open).toBe(false);
    expect(initial.revision).toBe(0);

    const nonAdmin = await gateway(
      signedInRequest("/api/admin/policy", newcomer),
    );
    expect(nonAdmin.status).toBe(403);

    const refused = await gateway(signedInRequest("/", newcomer));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(SIGNUPS_CLOSED_MESSAGE);
    expect(
      await userStub(newcomer.id).isProvisioned({
        schemaVersion: 1,
        userId: newcomer.id,
      }),
    ).toBe(false);

    const opened = await gateway(
      signedInRequest("/api/admin/policy", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: initial.revision,
        }),
      }),
    );
    expect(opened.status).toBe(200);
    const openPolicy = decodeDeploymentPolicyV1(await opened.json());
    expect(openPolicy.signups.open).toBe(true);
    expect(openPolicy.updatedBy).toBe(owner.id);

    const admitted = await gateway(signedInRequest("/", newcomer));
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe("admitted");
    expect(
      await userStub(newcomer.id).isProvisioned({
        schemaVersion: 1,
        userId: newcomer.id,
      }),
    ).toBe(true);

    const closed = await gateway(
      signedInRequest("/api/admin/policy", owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: false,
          revision: openPolicy.revision,
        }),
      }),
    );
    expect(closed.status).toBe(200);
    expect(decodeDeploymentPolicyV1(await closed.json()).signups.open).toBe(
      false,
    );

    const existing = await gateway(signedInRequest("/", newcomer));
    expect(existing.status).toBe(200);
    expect(await existing.text()).toBe("admitted");
  });

  test("an admin turns Applets on for an account without provisioning it", async () => {
    const owner = { id: "owner", email: "owner@example.com" };
    const guest = {
      id: `guest-${crypto.randomUUID()}`,
      email: "guest@example.com",
      name: "Guest",
    };
    const gateway = testGateway([
      { userId: guest.id, email: guest.email, name: guest.name },
    ]);

    const listed = await gateway(signedInRequest("/api/admin/users", owner));
    expect(listed.status).toBe(200);
    const before = decodeAdminUserListViewV1(await listed.json());
    expect(
      before.users.map((user) => [
        user.userId,
        isUserFeaturesUnavailable(user.features)
          ? "unavailable"
          : user.features.applets,
      ]),
    ).toEqual([
      ["owner", false],
      [guest.id, false],
    ]);

    const enabled = await gateway(
      signedInRequest(`/api/admin/users/${guest.id}/features`, owner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/set-features",
          applets: true,
        }),
      }),
    );
    expect(enabled.status).toBe(200);
    expect(decodeUserFeaturesV1(await enabled.json())).toMatchObject({
      applets: true,
      updatedBy: "owner",
    });
    expect((await readFeatures(guest.id)).applets).toBe(true);

    // Reading and writing an account's features is not admitting it: the
    // signup gate still sees an account that has never been provisioned.
    expect(
      await userStub(guest.id).isProvisioned({
        schemaVersion: 1,
        userId: guest.id,
      }),
    ).toBe(false);

    const refused = await gateway(
      signedInRequest(`/api/admin/users/${guest.id}/features`, guest, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/set-features",
          applets: false,
        }),
      }),
    );
    expect(refused.status).toBe(403);
    expect((await readFeatures(guest.id)).applets).toBe(true);
  });

  test("one account whose features cannot be read hides no other account's switch", async () => {
    const owner = { id: "owner", email: "owner@example.com" };
    const wedged = {
      id: `wedged-${crypto.randomUUID()}`,
      email: "wedged@example.com",
      name: "Wedged",
    };
    const guest = {
      id: `guest-${crypto.randomUUID()}`,
      email: "guest@example.com",
      name: "Guest",
    };
    await setFeatures(
      guest.id,
      { schemaVersion: 1, type: "user/set-features", applets: true },
      owner.id,
    );
    const gateway = testGateway(
      [
        { userId: wedged.id, email: wedged.email, name: wedged.name },
        { userId: guest.id, email: guest.email, name: guest.name },
      ],
      new Set([wedged.id]),
    );

    const listed = await gateway(signedInRequest("/api/admin/users", owner));
    expect(listed.status).toBe(200);
    const { users } = decodeAdminUserListViewV1(await listed.json());
    expect(
      users.map((user) => [
        user.userId,
        isUserFeaturesUnavailable(user.features)
          ? "unavailable"
          : user.features.applets,
      ]),
    ).toEqual([
      ["owner", false],
      [wedged.id, "unavailable"],
      [guest.id, true],
    ]);
  });
});
