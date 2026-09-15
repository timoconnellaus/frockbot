import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createAdminOperationsV1,
  type AdminOperationsHostV1,
  type AdminOperationsV1,
} from "@frockbot/app/admin/operations";
import {
  decodeAccountAccessViewV1,
  decodeAccountAdmissionDecisionV1,
  decodeDeploymentPolicyV1,
  decodeUserFeaturesV1,
  isAccountAccessUnavailable,
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
  UserBotStateBinding,
  UserConfigurationBinding,
  WorkerLoader,
} from "../src/contracts.ts";
import type { AuthPackageV1 } from "@frockbot/core/contracts";
import {
  cleanRetiredDeploymentPolicyV1,
  DEPLOYMENT_POLICY_SINGLETON_NAME,
  RETIRED_SIGNUPS_POLICY_KEY,
  RETIRED_SIGNUPS_POLICY_RECEIPT_KEY,
} from "../src/deployment-policy.ts";
import { createGateway } from "../src/gateway.ts";
import { createDeploymentPolicyAdminHost } from "../src/deployment-policy-admin-host.ts";

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

const accessHost = createDeploymentPolicyAdminHost(authority);

/**
 * Administration over the real authority and real User Durable Objects — what
 * the admin portal reaches through the app Worker's `AdminEntrypoint`. The
 * portal's own Access check is not in this test; the authority's behaviour is.
 */
function operations(
  listed: Array<{ userId: string; email: string; name: string }> = [],
  /** Accounts whose User Durable Object read fails, as an outage would. */
  unreadable: ReadonlySet<string> = new Set(),
): AdminOperationsV1 {
  const host: AdminOperationsHostV1 = {
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
  return createAdminOperationsV1(host);
}

/**
 * Sessions come from test headers; `x-test-verified` is the identity
 * provider's verification, which a real Google sign-in always carries.
 */
const auth: AuthPackageV1 = {
  handler: () => Promise.resolve(Response.json({ success: true })),
  signOut: () => Promise.resolve(new Response(null, { status: 303 })),
  startSignIn: () => Promise.resolve(new Response(null, { status: 302 })),
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

/**
 * The product Worker, with no administrative route of its own: administration
 * left the app, so a signed-in account — admin or not — reaches nothing here
 * but the product (ADR 0028).
 */
function testGateway() {
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
    backendContributions: [],
    allowDevelopmentIdentity: false,
  });
}

const owner = "owner@example.com";

function fresh(prefix: string, overrides: Partial<Identity> = {}): Identity {
  const id = `${prefix}-${crypto.randomUUID()}`;
  return { id, email: `${id}@example.com`, ...overrides };
}

async function setMode(
  admin: AdminOperationsV1,
  mode: AdmissionModeV1,
): Promise<DeploymentPolicyV1> {
  const current = await admin.readPolicy();
  const written = await admin.setAdmissionMode({
    schemaVersion: 1,
    command: {
      schemaVersion: 1,
      type: "deployment/set-admission-mode",
      mode,
      revision: current.revision,
    },
    updatedBy: owner,
  });
  expect(written.status).toBe("applied");
  if (written.status !== "applied") throw new Error("unreachable");
  return written.value;
}

async function setAccess(
  admin: AdminOperationsV1,
  userId: string,
  state: AccountAccessStateV1,
  revision?: number,
) {
  const read = await admin.readAccountAccess({ schemaVersion: 1, userId });
  return admin.setAccountAccess({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "account/set-access",
      state,
      revision: revision ?? read.access?.revision ?? 0,
    },
    updatedBy: owner,
  });
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
    const admin = operations();
    const newcomer = fresh("new");

    const initial = await admin.readPolicy();
    expect(initial.admission.mode).toBe("closed");
    expect(initial.revision).toBe(0);

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
    const admitted = await gateway(
      signedInRequest("/", { id: "owner", email: owner }),
    );
    expect(await admitted.text()).toBe("admitted");
  });

  test("an already provisioned User without access is refused", async () => {
    const gateway = testGateway();
    const admin = operations();
    const legacy = fresh("legacy");
    await userRpc(legacy.id).readConfiguration({
      schemaVersion: 1,
      userId: legacy.id,
    });
    expect(await provisioned(legacy.id)).toBe(true);
    await setMode(admin, "invite-only");
    await expectRefused(
      await gateway(signedInRequest("/api/identity", legacy)),
      "invitation-required",
    );
    await setMode(admin, "closed");
  });

  test("open admission activates, and closing it keeps the accounts it admitted", async () => {
    const gateway = testGateway();
    const admin = operations();
    const early = fresh("early");
    const late = fresh("late");
    await setMode(admin, "open");

    const admitted = await gateway(signedInRequest("/", early));
    expect(await admitted.text()).toBe("admitted");
    expect(await provisioned(early.id)).toBe(true);
    const access = await admin.readAccountAccess({
      schemaVersion: 1,
      userId: early.id,
    });
    expect(access.access).toMatchObject({
      state: "active",
      updatedBy: "admission",
    });

    const closed = await setMode(admin, "closed");
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
    const admin = operations();
    await setMode(admin, "open");
    const member = fresh("member");
    expect(
      (await gateway(signedInRequest("/api/identity", member))).status,
    ).toBe(200);
    for (const [state, reason] of [
      ["paused", "account-paused"],
      ["ended", "account-ended"],
      ["blocked", "account-blocked"],
    ] as const) {
      expect((await setAccess(admin, member.id, state)).status).toBe("applied");
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
    expect((await setAccess(admin, member.id, "active")).status).toBe(
      "applied",
    );
    expect(
      (await gateway(signedInRequest("/api/identity", member))).status,
    ).toBe(200);

    // Blocked before ever signing in: never provisioned, even in open mode.
    const stranger = fresh("stranger");
    expect((await setAccess(admin, stranger.id, "blocked")).status).toBe(
      "applied",
    );
    const page = await gateway(signedInRequest("/", stranger));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('data-reason="account-blocked"');
    expect(await provisioned(stranger.id)).toBe(false);
    await setMode(admin, "closed");
  });

  test("an email invitation binds to one verified identity and no other", async () => {
    const gateway = testGateway();
    const admin = operations();
    await setMode(admin, "invite-only");
    const email = `friend-${crypto.randomUUID()}@example.com`;
    const invited = await admin.inviteEmail({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "access/invite-email",
        email: email.toUpperCase(),
      },
      invitedBy: owner,
    });
    expect(invited.email).toBe(email);

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
    await setMode(admin, "closed");
  });

  test("concurrent sign-ins and admin writes serialize, and a stale admin write conflicts", async () => {
    const gateway = testGateway();
    const admin = operations();
    await setMode(admin, "open");
    const racer = fresh("racer");
    const [signIn, block, again] = await Promise.all([
      gateway(signedInRequest("/api/identity", racer)),
      admin.setAccountAccess({
        schemaVersion: 1,
        userId: racer.id,
        command: {
          schemaVersion: 1,
          type: "account/set-access",
          state: "blocked",
          revision: 0,
        },
        updatedBy: owner,
      }),
      gateway(signedInRequest("/api/identity", racer)),
    ]);
    const final = decodeAccountAccessViewV1(
      await authority().readAccountAccess({
        schemaVersion: 1,
        userId: racer.id,
      }),
    ).access as AccountAccessV1;
    if (block.status === "applied") {
      // The block won revision 1; no sign-in after it activated the account.
      expect(final).toMatchObject({ state: "blocked", revision: 1 });
      expect([signIn.status, again.status]).toContain(403);
    } else {
      expect(block).toMatchObject({ status: "conflict", currentRevision: 1 });
      expect(signIn.status).toBe(200);
      expect(final).toMatchObject({ state: "active", revision: 1 });
    }

    // Two admins racing on the same revision: exactly one lands.
    const [first, secondWrite] = await Promise.all([
      setAccess(admin, racer.id, "paused", final.revision),
      setAccess(admin, racer.id, "ended", final.revision),
    ]);
    expect([first.status, secondWrite.status].toSorted()).toEqual([
      "applied",
      "conflict",
    ]);
    await setMode(admin, "closed");
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

  test("the retired signups command is refused, not translated", async () => {
    const admin = operations();
    const before = await admin.readPolicy();
    await expect(
      admin.setAdmissionMode({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: before.revision,
        },
        updatedBy: owner,
      }),
    ).rejects.toThrow();
    expect(await admin.readPolicy()).toEqual(before);
  });

  test("an admin turns Applets on for an account without provisioning or admitting it", async () => {
    const guest = {
      userId: `guest-${crypto.randomUUID()}`,
      email: "guest@example.com",
      name: "Guest",
    };
    const admin = operations([guest]);

    const before = await admin.listAccounts();
    expect(
      before.users.map((user) => [
        user.userId,
        isUserFeaturesUnavailable(user.features)
          ? "unavailable"
          : user.features.applets,
      ]),
    ).toEqual([[guest.userId, false]]);
    // No access record and no sign-in: the list says so rather than guessing.
    const [listedGuest] = before.users;
    expect(
      isAccountAccessUnavailable(listedGuest!.access)
        ? "unavailable"
        : listedGuest!.access.access,
    ).toBeNull();

    const enabled = await admin.setAccountFeatures({
      schemaVersion: 1,
      userId: guest.userId,
      command: { schemaVersion: 1, type: "user/set-features", applets: true },
      updatedBy: owner,
    });
    expect(enabled).toMatchObject({ applets: true, updatedBy: owner });
    expect((await readFeatures(guest.userId)).applets).toBe(true);
    expect(await provisioned(guest.userId)).toBe(false);
  });

  test("one account whose features cannot be read hides no other account's switch", async () => {
    const wedged = {
      userId: `wedged-${crypto.randomUUID()}`,
      email: "wedged@example.com",
      name: "Wedged",
    };
    const guest = {
      userId: `guest-${crypto.randomUUID()}`,
      email: "guest@example.com",
      name: "Guest",
    };
    await setFeatures(
      guest.userId,
      { schemaVersion: 1, type: "user/set-features", applets: true },
      owner,
    );
    const admin = operations([wedged, guest], new Set([wedged.userId]));

    const { users } = await admin.listAccounts();
    expect(
      users.map((user) => [
        user.userId,
        isUserFeaturesUnavailable(user.features)
          ? "unavailable"
          : user.features.applets,
      ]),
    ).toEqual([
      [wedged.userId, "unavailable"],
      [guest.userId, true],
    ]);
  });
});
