import { describe, expect, test } from "bun:test";
import {
  createAdminBackendContribution,
  type AdminGatewayHost,
} from "./backend.js";
import {
  AccountAccessConflictError,
  DeploymentPolicyConflictError,
  defaultUserFeaturesV1,
  type AccountAccessV1,
  type AdminUserBillingV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type UserFeaturesV1,
} from "./shared.js";

function initialPolicy(): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    admission: { mode: "closed" },
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedBy: "deployment-default",
  };
}

/** The access authority's half of the host, in memory, with its compare-and-swap. */
function policyHost(): Pick<
  AdminGatewayHost,
  | "readDeploymentPolicy"
  | "setAdmissionMode"
  | "readAccountAccess"
  | "setAccountAccess"
  | "inviteEmail"
> & {
  access: Map<string, AccountAccessV1>;
  invitations: Map<string, EmailInvitationV1>;
} {
  let policy = initialPolicy();
  const access = new Map<string, AccountAccessV1>();
  const invitations = new Map<string, EmailInvitationV1>();
  return {
    access,
    invitations,
    readDeploymentPolicy: () => Promise.resolve(policy),
    setAdmissionMode: (command, updatedBy) => {
      if (command.revision !== policy.revision) {
        return Promise.reject(
          new DeploymentPolicyConflictError(policy.revision),
        );
      }
      policy = {
        schemaVersion: 1,
        revision: policy.revision + 1,
        admission: { mode: command.mode },
        updatedAt: "2026-09-01T01:00:00.000Z",
        updatedBy,
      };
      return Promise.resolve(policy);
    },
    readAccountAccess: (userId) =>
      Promise.resolve({
        schemaVersion: 1,
        userId,
        access: access.get(userId) ?? null,
      }),
    setAccountAccess: (userId, command, updatedBy) => {
      const revision = access.get(userId)?.revision ?? 0;
      if (command.revision !== revision) {
        return Promise.reject(new AccountAccessConflictError(revision));
      }
      const next: AccountAccessV1 = {
        schemaVersion: 1,
        userId,
        state: command.state,
        revision: revision + 1,
        updatedAt: "2026-09-01T01:00:00.000Z",
        updatedBy,
      };
      access.set(userId, next);
      return Promise.resolve(next);
    },
    inviteEmail: (command, invitedBy) => {
      const invitation = invitations.get(command.email) ?? {
        schemaVersion: 1,
        email: command.email,
        invitedAt: "2026-09-01T01:00:00.000Z",
        invitedBy,
      };
      invitations.set(command.email, invitation);
      return Promise.resolve(invitation);
    },
  };
}

/** A host whose accounts and features live in memory. */
function accountsHost(
  listed: Array<{ userId: string; email?: string; name?: string }>,
): Pick<
  AdminGatewayHost,
  | "listUsers"
  | "readUserFeatures"
  | "setUserFeatures"
  | "readUserBilling"
  | "grantUserCredit"
> & {
  features: Map<string, UserFeaturesV1>;
  credit: Map<string, number>;
  grants: Array<{ userId: string; id: string; cents: number; by: string }>;
} {
  const features = new Map<string, UserFeaturesV1>();
  const credit = new Map<string, number>();
  const grants: Array<{
    userId: string;
    id: string;
    cents: number;
    by: string;
  }> = [];
  const billing = (userId: string): AdminUserBillingV1 => ({
    includedMicros: 0,
    purchasedMicros: 0,
    complimentaryMicros: credit.get(userId) ?? 0,
    reservedMicros: 0,
    subscribed: false,
    canSpend: (credit.get(userId) ?? 0) > 0,
    suspended: false,
  });
  return {
    features,
    credit,
    grants,
    readUserBilling: (userId) => Promise.resolve(billing(userId)),
    grantUserCredit: (userId, command, by) => {
      if (!grants.some((g) => g.userId === userId && g.id === command.id)) {
        grants.push({ userId, id: command.id, cents: command.cents, by });
        credit.set(userId, (credit.get(userId) ?? 0) + command.cents * 10_000);
      }
      return Promise.resolve(billing(userId));
    },
    listUsers: () => Promise.resolve(listed),
    readUserFeatures: (userId) =>
      Promise.resolve(features.get(userId) ?? defaultUserFeaturesV1()),
    setUserFeatures: (userId, command, updatedBy) => {
      const next: UserFeaturesV1 = {
        schemaVersion: 1,
        applets: command.applets,
        pluginAuthoring: command.pluginAuthoring ?? false,
        plugins: command.plugins ?? [],
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy,
      };
      features.set(userId, next);
      return Promise.resolve(next);
    },
  };
}

const noCredit: AdminUserBillingV1 = {
  includedMicros: 0,
  purchasedMicros: 0,
  complimentaryMicros: 0,
  reservedMicros: 0,
  subscribed: false,
  canSpend: false,
  suspended: false,
};

describe("admin gateway contribution", () => {
  test("refuses non-admins before reading deployment policy", async () => {
    let reads = 0;
    const contribution = createAdminBackendContribution({
      ...policyHost(),
      ...accountsHost([]),
      readDeploymentPolicy: () => {
        reads += 1;
        return Promise.resolve(initialPolicy());
      },
    });

    const response = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy"),
      new URL("https://frockbot.test/api/admin/policy"),
      { userId: "ordinary-user", client: "browser", isAdmin: false },
    );

    expect(response?.status).toBe(403);
    expect(reads).toBe(0);
  });

  test("reads and updates the admission mode with an optimistic revision", async () => {
    const contribution = createAdminBackendContribution({
      ...accountsHost([]),
      ...policyHost(),
    });
    const context = {
      userId: "owner-id",
      client: "browser" as const,
      isAdmin: true,
    };

    const read = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy"),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(await read?.json<unknown>()).toEqual(initialPolicy());

    const update = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-admission-mode",
          mode: "invite-only",
          revision: 0,
        }),
      }),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(update?.status).toBe(200);
    expect(await update?.json()).toMatchObject({
      revision: 1,
      admission: { mode: "invite-only" },
      updatedBy: "owner-id",
    });

    const conflict = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-admission-mode",
          mode: "open",
          revision: 0,
        }),
      }),
      new URL("https://frockbot.test/api/admin/policy"),
      context,
    );
    expect(conflict?.status).toBe(409);
    expect(await conflict?.json()).toMatchObject({
      code: "revision-conflict",
      currentRevision: 1,
    });
  });

  test("lists every account, the signed-in admin included, with what each holds", async () => {
    const host = accountsHost([
      { userId: "guest", email: "guest@example.com", name: "Guest" },
    ]);
    const contribution = createAdminBackendContribution({
      ...policyHost(),
      ...host,
    });
    const context = {
      userId: "development",
      client: "browser" as const,
      isAdmin: true,
    };

    const refused = await contribution.route(
      new Request("https://frockbot.test/api/admin/users"),
      new URL("https://frockbot.test/api/admin/users"),
      { ...context, isAdmin: false },
    );
    expect(refused?.status).toBe(403);

    const listed = await contribution.route(
      new Request("https://frockbot.test/api/admin/users"),
      new URL("https://frockbot.test/api/admin/users"),
      context,
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json<unknown>()).toEqual({
      schemaVersion: 1,
      users: [
        {
          userId: "development",
          features: defaultUserFeaturesV1(),
          billing: noCredit,
        },
        {
          userId: "guest",
          email: "guest@example.com",
          name: "Guest",
          features: defaultUserFeaturesV1(),
          billing: noCredit,
        },
      ],
    });

    const enabled = await contribution.route(
      new Request("https://frockbot.test/api/admin/users/guest/features", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/set-features",
          applets: true,
        }),
      }),
      new URL("https://frockbot.test/api/admin/users/guest/features"),
      context,
    );
    expect(enabled?.status).toBe(200);
    expect(await enabled?.json()).toMatchObject({
      applets: true,
      updatedBy: "development",
    });
    expect(host.features.get("guest")?.applets).toBe(true);

    const relisted = await contribution.route(
      new Request("https://frockbot.test/api/admin/users"),
      new URL("https://frockbot.test/api/admin/users"),
      context,
    );
    const { users } = (await relisted?.json()) as {
      users: Array<{ userId: string; features: { applets: boolean } }>;
    };
    expect(users.map((user) => [user.userId, user.features.applets])).toEqual([
      ["development", false],
      ["guest", true],
    ]);
  });

  test("an admin grants credit once per id, and the list shows what it left", async () => {
    const host = accountsHost([
      { userId: "guest", email: "guest@example.com", name: "Guest" },
    ]);
    const contribution = createAdminBackendContribution({
      ...policyHost(),
      ...host,
    });
    const context = {
      userId: "tim",
      client: "browser" as const,
      isAdmin: true,
    };
    const grant = (body: unknown) =>
      contribution.route(
        new Request("https://frockbot.test/api/admin/users/guest/credit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        new URL("https://frockbot.test/api/admin/users/guest/credit"),
        context,
      );
    const command = {
      schemaVersion: 1,
      type: "user/grant-credit",
      id: "grant-1",
      cents: 1000,
      reason: "Early tester",
    };
    const granted = await grant(command);
    expect(granted?.status).toBe(200);
    expect(await granted?.json()).toMatchObject({
      complimentaryMicros: 10_000_000,
      canSpend: true,
    });
    // The same tap again lands once.
    await grant(command);
    expect(host.grants).toEqual([
      { userId: "guest", id: "grant-1", cents: 1000, by: "tim" },
    ]);

    for (const bad of [
      { ...command, cents: 0 },
      { ...command, cents: 100_001 },
      { ...command, cents: 12.5 },
      { ...command, reason: "" },
      { ...command, id: "not valid!" },
      { ...command, extra: true },
    ]) {
      expect((await grant(bad))?.status).toBe(400);
    }
    const refused = await grant({ ...command, id: "grant-2" });
    expect(refused?.status).toBe(200);
    expect(
      (
        await contribution.route(
          new Request("https://frockbot.test/api/admin/users/guest/credit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(command),
          }),
          new URL("https://frockbot.test/api/admin/users/guest/credit"),
          { ...context, isAdmin: false },
        )
      )?.status,
    ).toBe(403);

    const listed = await contribution.route(
      new Request("https://frockbot.test/api/admin/users"),
      new URL("https://frockbot.test/api/admin/users"),
      context,
    );
    const { users } = (await listed?.json()) as {
      users: Array<{
        userId: string;
        billing: { complimentaryMicros: number };
      }>;
    };
    expect(
      users.map((user) => [user.userId, user.billing.complimentaryMicros]),
    ).toEqual([
      ["tim", 0],
      ["guest", 20_000_000],
    ]);
  });

  test("one unreadable account is marked unavailable and hides no other account", async () => {
    const host = accountsHost([
      { userId: "guest", email: "guest@example.com", name: "Guest" },
      { userId: "wedged", email: "wedged@example.com", name: "Wedged" },
      { userId: "other", email: "other@example.com", name: "Other" },
    ]);
    await host.setUserFeatures(
      "other",
      { schemaVersion: 1, type: "user/set-features", applets: true },
      "development",
    );
    const contribution = createAdminBackendContribution({
      ...policyHost(),
      ...host,
      readUserFeatures: (userId) =>
        userId === "wedged"
          ? Promise.reject(new Error("Durable Object reset while responding"))
          : host.readUserFeatures(userId),
    });

    const listed = await contribution.route(
      new Request("https://frockbot.test/api/admin/users"),
      new URL("https://frockbot.test/api/admin/users"),
      { userId: "development", client: "browser", isAdmin: true },
    );
    expect(listed?.status).toBe(200);
    const { users } = (await listed?.json()) as {
      users: Array<{ userId: string; features: Record<string, unknown> }>;
    };
    expect(
      users.map((user): [string, unknown] => [user.userId, user.features]),
    ).toEqual([
      ["development", defaultUserFeaturesV1()],
      ["guest", defaultUserFeaturesV1()],
      ["wedged", { unavailable: true }],
      [
        "other",
        {
          ...defaultUserFeaturesV1(),
          applets: true,
          updatedAt: "2026-09-11T00:00:00.000Z",
          updatedBy: "development",
        },
      ],
    ]);
    // The unreadable account is never reported as off: "off" is a value.
    expect(users[2]?.features).not.toHaveProperty("applets");
  });

  test("refuses a malformed account id or command without touching the host", async () => {
    let writes = 0;
    const host = accountsHost([]);
    const contribution = createAdminBackendContribution({
      ...policyHost(),
      ...host,
      setUserFeatures: (...args) => {
        writes += 1;
        return host.setUserFeatures(...args);
      },
    });
    const context = {
      userId: "owner-id",
      client: "browser" as const,
      isAdmin: true,
    };
    const command = JSON.stringify({
      schemaVersion: 1,
      type: "user/set-features",
      applets: true,
    });
    const badId = await contribution.route(
      new Request(
        "https://frockbot.test/api/admin/users/not%20an%20id/features",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: command,
        },
      ),
      new URL("https://frockbot.test/api/admin/users/not%20an%20id/features"),
      context,
    );
    expect(badId?.status).toBe(400);
    const badCommand = await contribution.route(
      new Request("https://frockbot.test/api/admin/users/guest/features", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, applets: true }),
      }),
      new URL("https://frockbot.test/api/admin/users/guest/features"),
      context,
    );
    expect(badCommand?.status).toBe(400);
    const unknown = await contribution.route(
      new Request("https://frockbot.test/api/admin/nothing"),
      new URL("https://frockbot.test/api/admin/nothing"),
      context,
    );
    expect(unknown?.status).toBe(404);
    expect(writes).toBe(0);
  });
  test("the retired signups command is refused, not translated", async () => {
    const contribution = createAdminBackendContribution({
      ...accountsHost([]),
      ...policyHost(),
    });
    const response = await contribution.route(
      new Request("https://frockbot.test/api/admin/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: 0,
        }),
      }),
      new URL("https://frockbot.test/api/admin/policy"),
      { userId: "owner-id", client: "browser", isAdmin: true },
    );
    expect(response?.status).toBe(400);
  });

  test("an admin reads and sets one account's access under its revision", async () => {
    const host = policyHost();
    const contribution = createAdminBackendContribution({
      ...accountsHost([]),
      ...host,
    });
    const context = {
      userId: "owner-id",
      client: "browser" as const,
      isAdmin: true,
    };
    const path = "https://frockbot.test/api/admin/users/guest/access";
    const set = (body: unknown, admin = context) =>
      contribution.route(
        new Request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        new URL(path),
        admin,
      );

    const unread = await contribution.route(
      new Request(path),
      new URL(path),
      context,
    );
    expect(await unread?.json<unknown>()).toEqual({
      schemaVersion: 1,
      userId: "guest",
      access: null,
    });

    const paused = await set({
      schemaVersion: 1,
      type: "account/set-access",
      state: "paused",
      revision: 0,
    });
    expect(paused?.status).toBe(200);
    expect(await paused?.json()).toMatchObject({
      userId: "guest",
      state: "paused",
      revision: 1,
      updatedBy: "owner-id",
    });

    const stale = await set({
      schemaVersion: 1,
      type: "account/set-access",
      state: "active",
      revision: 0,
    });
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({
      code: "revision-conflict",
      currentRevision: 1,
    });
    expect(host.access.get("guest")?.state).toBe("paused");

    for (const bad of [
      {
        schemaVersion: 1,
        type: "account/set-access",
        state: "gone",
        revision: 1,
      },
      { schemaVersion: 1, type: "account/set-access", state: "active" },
      {
        schemaVersion: 1,
        type: "account/set-access",
        state: "active",
        revision: 1,
        userId: "someone-else",
      },
    ]) {
      expect((await set(bad))?.status).toBe(400);
    }
    expect(
      (
        await set(
          {
            schemaVersion: 1,
            type: "account/set-access",
            state: "active",
            revision: 1,
          },
          { ...context, isAdmin: false },
        )
      )?.status,
    ).toBe(403);
    expect(host.access.get("guest")?.revision).toBe(1);
  });

  test("an admin invites a normalized address, once", async () => {
    const host = policyHost();
    const contribution = createAdminBackendContribution({
      ...accountsHost([]),
      ...host,
    });
    const path = "https://frockbot.test/api/admin/invitations";
    const invite = (body: unknown, isAdmin = true) =>
      contribution.route(
        new Request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        new URL(path),
        { userId: "owner-id", client: "browser", isAdmin },
      );
    const command = {
      schemaVersion: 1,
      type: "access/invite-email",
      email: " Guest@Example.com ",
    };
    const invited = await invite(command);
    expect(invited?.status).toBe(200);
    expect(await invited?.json()).toMatchObject({
      email: "guest@example.com",
      invitedBy: "owner-id",
    });
    expect((await invite(command))?.status).toBe(200);
    expect([...host.invitations.keys()]).toEqual(["guest@example.com"]);
    expect(
      (await invite({ ...command, email: "not-an-address" }))?.status,
    ).toBe(400);
    expect((await invite({ ...command, userId: "u1" }))?.status).toBe(400);
    expect((await invite(command, false))?.status).toBe(403);
  });
});
