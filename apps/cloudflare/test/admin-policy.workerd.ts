import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createAdminBackendContribution,
  type AdminGatewayHost,
} from "@frockbot/app/admin/backend";
import {
  AccountAccessConflictError,
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeAccountAdmissionDecisionV1,
  decodeAdminUserListViewV1,
  decodeDeploymentPolicyV1,
  decodeEmailInvitationV1,
  decodeUserFeaturesV1,
  DeploymentPolicyConflictError,
  isUserFeaturesUnavailable,
  type AccountAccessStateV1,
  type AccountAccessV1,
  type AdmissionModeV1,
  type DeploymentPolicyV1,
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
import {
  cleanRetiredDeploymentPolicyV1,
  DEPLOYMENT_POLICY_SINGLETON_NAME,
  RETIRED_SIGNUPS_POLICY_KEY,
  RETIRED_SIGNUPS_POLICY_RECEIPT_KEY,
} from "../src/deployment-policy.ts";
import { createGateway } from "../src/gateway.ts";

interface UserRpc {
  readConfiguration(input: unknown): Promise<unknown>;
  readFeatures(input: unknown): Promise<unknown>;
  setFeatures(input: unknown): Promise<unknown>;
}

function authority() {
  return env.DEPLOYMENT_POLICY.getByName(DEPLOYMENT_POLICY_SINGLETON_NAME);
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

function userRpc(userId: string): UserRpc {
  return userStub(userId) as unknown as UserRpc;
}

/** Whether anything has provisioned this User: the identity pin is that act. */
async function provisioned(userId: string): Promise<boolean> {
  return runInDurableObject(
    userStub(userId),
    async (_instance, state) =>
      (await state.storage.get("user:identity")) !== undefined,
  );
}

async function readPolicy(): Promise<DeploymentPolicyV1> {
  return decodeDeploymentPolicyV1(
    await authority().readPolicy({ schemaVersion: 1 }),
  );
}

function applied<T>(
  write:
    | { status: "applied"; value: T }
    | { status: "conflict"; currentRevision: number },
  conflict: (revision: number) => Error,
): T {
  if (write.status === "conflict") throw conflict(write.currentRevision);
  return write.value;
}

async function readFeatures(userId: string): Promise<UserFeaturesV1> {
  return decodeUserFeaturesV1(
    await userRpc(userId).readFeatures({ schemaVersion: 1, userId }),
  );
}

async function setFeatures(
  userId: string,
  command: SetUserFeaturesCommandV1,
  updatedBy: string,
): Promise<UserFeaturesV1> {
  return decodeUserFeaturesV1(
    await userRpc(userId).setFeatures({
      schemaVersion: 1,
      userId,
      command,
      updatedBy,
    }),
  );
}

/** The production Worker's host over the real authority, minus the Worker. */
const accessHost: Pick<
  AdminGatewayHost,
  | "readDeploymentPolicy"
  | "setAdmissionMode"
  | "readAccountAccess"
  | "setAccountAccess"
  | "inviteEmail"
> = {
  readDeploymentPolicy: readPolicy,
  setAdmissionMode: async (command, updatedBy) =>
    decodeDeploymentPolicyV1(
      applied(
        await authority().setAdmissionMode({
          schemaVersion: 1,
          command,
          updatedBy,
        }),
        (revision) => new DeploymentPolicyConflictError(revision),
      ),
    ),
  readAccountAccess: async (userId) =>
    decodeAccountAccessViewV1(
      await authority().readAccountAccess({ schemaVersion: 1, userId }),
    ),
  setAccountAccess: async (userId, command, updatedBy) =>
    decodeAccountAccessV1(
      applied(
        await authority().setAccountAccess({
          schemaVersion: 1,
          userId,
          command,
          updatedBy,
        }),
        (revision) => new AccountAccessConflictError(revision),
      ),
    ),
  inviteEmail: async (command, invitedBy) =>
    decodeEmailInvitationV1(
      await authority().inviteEmail({ schemaVersion: 1, command, invitedBy }),
    ),
};

/**
 * Sessions come from test headers; `x-test-verified` is the identity
 * provider's verification, which a real Google sign-in always carries.
 */
const auth: GatewayAuth = {
  handler: () => Promise.resolve(Response.json({ success: true })),
  getSession: (headers) => {
    const id = headers.get("x-test-user");
    if (!id) return Promise.resolve(null);
    const email = headers.get("x-test-email");
    return Promise.resolve({
      user: {
        id,
        ...(email ? { email } : {}),
        emailVerified: headers.get("x-test-verified") === "true",
      },
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

interface Identity {
  id: string;
  email: string;
  verified?: boolean;
}

function signedInRequest(
  path: string,
  identity: Identity,
  init?: RequestInit,
): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-test-user", identity.id);
  headers.set("x-test-email", identity.email);
  headers.set("x-test-verified", String(identity.verified ?? true));
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

function postJson(path: string, identity: Identity, body: unknown): Request {
  return signedInRequest(path, identity, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function testGateway(
  listed: Array<{ userId: string; email: string; name: string }> = [],
  /** Accounts whose User Durable Object read fails, as an outage would. */
  unreadable: ReadonlySet<string> = new Set(),
) {
  const host: AdminGatewayHost = {
    ...accessHost,
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
    // What `index.ts` does, over the real authority.
    admitAccount: async (identity) =>
      decodeAccountAdmissionDecisionV1(
        await authority().admitAccount(identity),
      ),
    adminEmails: "owner@example.com",
    applicationHashFor: async (userId) => {
      await userRpc(userId).readConfiguration({ schemaVersion: 1, userId });
      return "foundation-v1";
    },
    botStateFor: () => ({}) as UserBotStateBinding,
    userConfigurationFor: () => ({}) as UserConfigurationBinding,
    botConfigurationFor: () => ({}) as BotConfigurationBinding,
    backendContributions: [createAdminBackendContribution(host)],
    allowDevelopmentIdentity: false,
  });
}

const owner: Identity = { id: "owner", email: "owner@example.com" };

function fresh(prefix: string, overrides: Partial<Identity> = {}): Identity {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return { id, email: `${id}@example.com`, ...overrides };
}

async function setMode(
  gateway: ReturnType<typeof testGateway>,
  mode: AdmissionModeV1,
): Promise<DeploymentPolicyV1> {
  const current = await readPolicy();
  const response = await gateway(
    postJson("/api/admin/policy", owner, {
      schemaVersion: 1,
      type: "deployment/set-admission-mode",
      mode,
      revision: current.revision,
    }),
  );
  expect(response.status).toBe(200);
  return decodeDeploymentPolicyV1(await response.json());
}

async function setAccess(
  gateway: ReturnType<typeof testGateway>,
  userId: string,
  state: AccountAccessStateV1,
  revision?: number,
): Promise<Response> {
  const read = decodeAccountAccessViewV1(
    await (
      await gateway(signedInRequest(`/api/admin/users/${userId}/access`, owner))
    ).json(),
  );
  return gateway(
    postJson(`/api/admin/users/${userId}/access`, owner, {
      schemaVersion: 1,
      type: "account/set-access",
      state,
      revision: revision ?? read.access?.revision ?? 0,
    }),
  );
}

async function expectRefused(
  response: Response,
  reason: string,
): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "account-access-refused",
    reason,
  });
}

describe("beta access authority in workerd", () => {
  test("defaults closed; a signed-in identity is refused and never provisioned", async () => {
    const gateway = testGateway();
    const newcomer = fresh("new");

    const initial = await readPolicy();
    expect(initial.admission.mode).toBe("closed");
    expect(initial.revision).toBe(0);

    expect(
      (await gateway(signedInRequest("/api/admin/policy", newcomer))).status,
    ).toBe(403);

    const page = await gateway(signedInRequest("/", newcomer));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain(
      "FrockBot isn't admitting new accounts right now.",
    );
    await expectRefused(
      await gateway(signedInRequest("/api/identity", newcomer)),
      "admission-closed",
    );
    expect(await provisioned(newcomer.id)).toBe(false);

    // An admin is admitted in the same closed deployment, with no record.
    const admitted = await gateway(signedInRequest("/", owner));
    expect(await admitted.text()).toBe("admitted");
  });

  test("an already provisioned User without access is refused", async () => {
    const gateway = testGateway();
    const legacy = fresh("legacy");
    await userRpc(legacy.id).readConfiguration({
      schemaVersion: 1,
      userId: legacy.id,
    });
    expect(await provisioned(legacy.id)).toBe(true);
    await setMode(gateway, "invite-only");
    await expectRefused(
      await gateway(signedInRequest("/api/identity", legacy)),
      "invitation-required",
    );
    await setMode(gateway, "closed");
  });

  test("open admission activates, and closing it keeps the accounts it admitted", async () => {
    const gateway = testGateway();
    const early = fresh("early");
    const late = fresh("late");
    await setMode(gateway, "open");

    const admitted = await gateway(signedInRequest("/", early));
    expect(await admitted.text()).toBe("admitted");
    expect(await provisioned(early.id)).toBe(true);
    const access = decodeAccountAccessViewV1(
      await (
        await gateway(
          signedInRequest(`/api/admin/users/${early.id}/access`, owner),
        )
      ).json(),
    );
    expect(access.access).toMatchObject({
      state: "active",
      updatedBy: "admission",
    });

    const closed = await setMode(gateway, "closed");
    expect(closed.admission.mode).toBe("closed");
    expect(await (await gateway(signedInRequest("/", early))).text()).toBe(
      "admitted",
    );
    await expectRefused(
      await gateway(signedInRequest("/api/identity", late)),
      "admission-closed",
    );
    expect(await provisioned(late.id)).toBe(false);
  });

  test("pausing, ending and blocking land on the next request and beat open mode", async () => {
    const gateway = testGateway();
    await setMode(gateway, "open");
    const member = fresh("member");
    expect(
      (await gateway(signedInRequest("/api/identity", member))).status,
    ).toBe(200);
    for (const [state, reason] of [
      ["paused", "account-paused"],
      ["ended", "account-ended"],
      ["blocked", "account-blocked"],
    ] as const) {
      expect((await setAccess(gateway, member.id, state)).status).toBe(200);
      await expectRefused(
        await gateway(signedInRequest("/api/identity", member)),
        reason,
      );
      // Still refused: open mode never re-activates an explicit state.
      await expectRefused(
        await gateway(signedInRequest("/api/identity", member)),
        reason,
      );
    }
    expect((await setAccess(gateway, member.id, "active")).status).toBe(200);
    expect(
      (await gateway(signedInRequest("/api/identity", member))).status,
    ).toBe(200);

    // Blocked before ever signing in: never provisioned, even in open mode.
    const stranger = fresh("stranger");
    expect((await setAccess(gateway, stranger.id, "blocked")).status).toBe(200);
    const page = await gateway(signedInRequest("/", stranger));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('data-reason="account-blocked"');
    expect(await provisioned(stranger.id)).toBe(false);
    await setMode(gateway, "closed");
  });

  test("an email invitation binds to one verified identity and no other", async () => {
    const gateway = testGateway();
    await setMode(gateway, "invite-only");
    const email = `friend-${crypto.randomUUID()}@example.com`;
    const invited = await gateway(
      postJson("/api/admin/invitations", owner, {
        schemaVersion: 1,
        type: "access/invite-email",
        email: email.toUpperCase(),
      }),
    );
    expect(invited.status).toBe(200);
    expect(decodeEmailInvitationV1(await invited.json()).email).toBe(email);

    // Nobody can invite themselves.
    const self = fresh("self");
    expect(
      (
        await gateway(
          postJson("/api/admin/invitations", self, {
            schemaVersion: 1,
            type: "access/invite-email",
            email: self.email,
          }),
        )
      ).status,
    ).toBe(403);

    const unverified = fresh("unverified", { email, verified: false });
    await expectRefused(
      await gateway(signedInRequest("/api/identity", unverified)),
      "invitation-required",
    );
    expect(await provisioned(unverified.id)).toBe(false);

    const friend = fresh("friend", { email });
    expect(await (await gateway(signedInRequest("/", friend))).text()).toBe(
      "admitted",
    );

    const second = fresh("second", { email });
    await expectRefused(
      await gateway(signedInRequest("/api/identity", second)),
      "invitation-required",
    );
    expect(await provisioned(second.id)).toBe(false);
    await setMode(gateway, "closed");
  });

  test("concurrent sign-ins and admin writes serialize, and a stale admin write conflicts", async () => {
    const gateway = testGateway();
    await setMode(gateway, "open");
    const racer = fresh("racer");
    const [signIn, block, again] = await Promise.all([
      gateway(signedInRequest("/api/identity", racer)),
      gateway(
        postJson(`/api/admin/users/${racer.id}/access`, owner, {
          schemaVersion: 1,
          type: "account/set-access",
          state: "blocked",
          revision: 0,
        }),
      ),
      gateway(signedInRequest("/api/identity", racer)),
    ]);
    const final = decodeAccountAccessViewV1(
      await authority().readAccountAccess({
        schemaVersion: 1,
        userId: racer.id,
      }),
    ).access as AccountAccessV1;
    if (block.status === 200) {
      // The block won revision 1; no sign-in after it activated the account.
      expect(final).toMatchObject({ state: "blocked", revision: 1 });
      expect([signIn.status, again.status]).toContain(403);
    } else {
      expect(block.status).toBe(409);
      expect(signIn.status).toBe(200);
      expect(final).toMatchObject({ state: "active", revision: 1 });
    }

    // Two admins racing on the same revision: exactly one lands.
    const [first, secondWrite] = await Promise.all([
      setAccess(gateway, racer.id, "paused", final.revision),
      setAccess(gateway, racer.id, "ended", final.revision),
    ]);
    expect([first.status, secondWrite.status].sort()).toEqual([200, 409]);
    await setMode(gateway, "closed");
  });

  test("the retired signups record is cleaned up on real storage, repeatably", async () => {
    await readPolicy();
    await runInDurableObject(authority(), (_instance, state) => {
      // A deployment that ran the signups switch, before this release.
      state.storage.kv.delete(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY);
      state.storage.kv.put(RETIRED_SIGNUPS_POLICY_KEY, {
        schemaVersion: 1,
        revision: 3,
        signups: { open: true },
        updatedAt: "2026-09-01T00:00:00.000Z",
        updatedBy: "owner",
      });
      cleanRetiredDeploymentPolicyV1(state.storage);
      expect(state.storage.kv.get(RETIRED_SIGNUPS_POLICY_KEY)).toBeUndefined();
      const receipt = state.storage.kv.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY);
      expect(receipt).toMatchObject({ deleted: 1 });
      cleanRetiredDeploymentPolicyV1(state.storage);
      expect(state.storage.kv.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY)).toEqual(
        receipt,
      );
    });
    // The authority still answers after cleanup, from its own records.
    expect((await readPolicy()).admission.mode).toMatch(
      /^(closed|invite-only|open)$/,
    );
  });

  test("the retired signups command is refused at the admin route", async () => {
    const gateway = testGateway();
    const before = await readPolicy();
    const response = await gateway(
      postJson("/api/admin/policy", owner, {
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: before.revision,
      }),
    );
    expect(response.status).toBe(400);
    expect(await readPolicy()).toEqual(before);
  });

  test("an admin turns Applets on for an account without provisioning or admitting it", async () => {
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
      postJson(`/api/admin/users/${guest.id}/features`, owner, {
        schemaVersion: 1,
        type: "user/set-features",
        applets: true,
      }),
    );
    expect(enabled.status).toBe(200);
    expect(decodeUserFeaturesV1(await enabled.json())).toMatchObject({
      applets: true,
      updatedBy: "owner",
    });
    expect((await readFeatures(guest.id)).applets).toBe(true);
    expect(await provisioned(guest.id)).toBe(false);

    await expectRefused(
      await gateway(
        postJson(`/api/admin/users/${guest.id}/features`, guest, {
          schemaVersion: 1,
          type: "user/set-features",
          applets: false,
        }),
      ),
      "admission-closed",
    );
    expect((await readFeatures(guest.id)).applets).toBe(true);
  });

  test("one account whose features cannot be read hides no other account's switch", async () => {
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
