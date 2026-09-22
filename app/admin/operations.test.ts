import { describe, expect, test } from "bun:test";
import {
  adminGatedPluginsV1,
  createAdminOperationsV1,
  type AdminOperationsHostV1,
} from "./operations.js";
import {
  AccountAccessConflictError,
  DeploymentPolicyConflictError,
  defaultUserFeaturesV1,
  isAccountAccessUnavailable,
  isUserFeaturesUnavailable,
  type AccountAccessV1,
  type AdminUserBillingV1,
  type DeploymentPolicyV1,
  type EmailInvitationV1,
  type UserFeaturesV1,
} from "./shared.js";
import {
  decodePluginCatalogV1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";

function initialPolicy(): DeploymentPolicyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    admission: { mode: "closed" },
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedBy: "deployment-default",
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

interface Recorded {
  access: Map<string, AccountAccessV1>;
  invitations: Map<string, EmailInvitationV1>;
  features: Map<string, UserFeaturesV1>;
  credit: Map<string, number>;
  grants: Array<{ userId: string; id: string; cents: number; by: string }>;
}

/**
 * The whole administrative host in memory, with the authority's two
 * compare-and-swaps and the ledger's idempotency.
 */
function memoryHost(
  listed: Array<{ userId: string; email?: string; name?: string }> = [],
  options: {
    /** Accounts whose User Durable Object read fails, as an outage would. */
    unreadableFeatures?: ReadonlySet<string>;
    /** Accounts whose access record cannot be read. */
    unreadableAccess?: ReadonlySet<string>;
  } = {},
): AdminOperationsHostV1 & { recorded: Recorded } {
  let policy = initialPolicy();
  const recorded: Recorded = {
    access: new Map(),
    invitations: new Map(),
    features: new Map(),
    credit: new Map(),
    grants: [],
  };
  const billing = (userId: string): AdminUserBillingV1 => ({
    ...noCredit,
    complimentaryMicros: recorded.credit.get(userId) ?? 0,
    canSpend: (recorded.credit.get(userId) ?? 0) > 0,
  });
  return {
    recorded,
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
      options.unreadableAccess?.has(userId)
        ? Promise.reject(new Error("authority is unreachable"))
        : Promise.resolve({
            schemaVersion: 1,
            userId,
            access: recorded.access.get(userId) ?? null,
          }),
    setAccountAccess: (userId, command, updatedBy) => {
      const revision = recorded.access.get(userId)?.revision ?? 0;
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
      recorded.access.set(userId, next);
      return Promise.resolve(next);
    },
    inviteEmail: (command, invitedBy) => {
      const invitation = recorded.invitations.get(command.email) ?? {
        schemaVersion: 1,
        email: command.email,
        invitedAt: "2026-09-01T01:00:00.000Z",
        invitedBy,
      };
      recorded.invitations.set(command.email, invitation);
      return Promise.resolve(invitation);
    },
    listUsers: () => Promise.resolve(listed),
    readUserFeatures: (userId) =>
      options.unreadableFeatures?.has(userId)
        ? Promise.reject(new Error("Durable Object reset while responding"))
        : Promise.resolve(
            recorded.features.get(userId) ?? defaultUserFeaturesV1(),
          ),
    setUserFeatures: (userId, command, updatedBy) => {
      const next: UserFeaturesV1 = {
        schemaVersion: 1,
        pluginAuthoring: command.pluginAuthoring ?? false,
        plugins: command.plugins ?? [],
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy,
      };
      recorded.features.set(userId, next);
      return Promise.resolve(next);
    },
    readUserBilling: (userId) => Promise.resolve(billing(userId)),
    grantUserCredit: (userId, command, by) => {
      if (
        !recorded.grants.some(
          (grant) => grant.userId === userId && grant.id === command.id,
        )
      ) {
        recorded.grants.push({
          userId,
          id: command.id,
          cents: command.cents,
          by,
        });
        recorded.credit.set(
          userId,
          (recorded.credit.get(userId) ?? 0) + command.cents * 10_000,
        );
      }
      return Promise.resolve(billing(userId));
    },
  };
}

function seeded(
  pluginId: string,
  seed: SeededPluginV1["seed"],
): Record<string, unknown> {
  return {
    pluginId,
    displayName: `The ${pluginId} plugin`,
    description: `The ${pluginId} plugin`,
    seed,
    artifact: {
      contentHash: "a".repeat(64),
      size: 12,
      mediaType: "application/javascript",
      bundlerVersion: "seed",
    },
    descriptor: {
      id: pluginId,
      displayName: pluginId,
      version: "1.0.0",
      contractVersion: 4,
      tools: [{ name: "ping", description: "Pings", inputSchema: {} }],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    },
  };
}

const catalog = decodePluginCatalogV1([
  seeded("open-plugin", "default-on"),
  seeded("gated-plugin", "admin-gated"),
]);

const owner = "owner@example.com";

describe("the deployment's admission mode", () => {
  test("is read, and written under the revision it was read at", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    const read = await admin.readPolicy();
    expect(read.admission.mode).toBe("closed");

    const written = await admin.setAdmissionMode({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/set-admission-mode",
        mode: "invite-only",
        revision: read.revision,
      },
      updatedBy: owner,
    });
    expect(written).toEqual({
      status: "applied",
      value: {
        schemaVersion: 1,
        revision: 1,
        admission: { mode: "invite-only" },
        updatedAt: "2026-09-01T01:00:00.000Z",
        updatedBy: owner,
      },
    });
  });

  test("a write on a revision someone else moved is a conflict, not a failure", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);
    const command = {
      schemaVersion: 1,
      type: "deployment/set-admission-mode",
      mode: "open",
      revision: 0,
    };

    expect(
      (
        await admin.setAdmissionMode({
          schemaVersion: 1,
          command,
          updatedBy: owner,
        })
      ).status,
    ).toBe("applied");
    expect(
      await admin.setAdmissionMode({
        schemaVersion: 1,
        command,
        updatedBy: owner,
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
  });

  test("the retired signups command is refused, not translated", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    await expect(
      admin.setAdmissionMode({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: 0,
        },
        updatedBy: owner,
      }),
    ).rejects.toThrow("unknown fields");
    expect((await admin.readPolicy()).revision).toBe(0);
  });
});

describe("one account's access", () => {
  test("is read and set under its revision; an account with no record is 0", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    expect(
      await admin.readAccountAccess({ schemaVersion: 1, userId: "guest" }),
    ).toEqual({ schemaVersion: 1, userId: "guest", access: null });

    const invited = await admin.setAccountAccess({
      schemaVersion: 1,
      userId: "guest",
      command: {
        schemaVersion: 1,
        type: "account/set-access",
        state: "invited",
        revision: 0,
      },
      updatedBy: owner,
    });
    expect(invited).toMatchObject({
      status: "applied",
      value: { state: "invited", revision: 1, updatedBy: owner },
    });

    expect(
      await admin.setAccountAccess({
        schemaVersion: 1,
        userId: "guest",
        command: {
          schemaVersion: 1,
          type: "account/set-access",
          state: "blocked",
          revision: 0,
        },
        updatedBy: owner,
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect(host.recorded.access.get("guest")?.state).toBe("invited");
  });

  test("an account id that is not an identifier never reaches the authority", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    await expect(
      admin.readAccountAccess({ schemaVersion: 1, userId: "not an id" }),
    ).rejects.toThrow("invalid");
    await expect(
      admin.setAccountAccess({
        schemaVersion: 1,
        userId: "not an id",
        command: {
          schemaVersion: 1,
          type: "account/set-access",
          state: "active",
          revision: 0,
        },
        updatedBy: owner,
      }),
    ).rejects.toThrow("invalid");
    expect(host.recorded.access.size).toBe(0);
  });
});

describe("an email invitation", () => {
  test("is normalized and idempotent", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    const first = await admin.inviteEmail({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "access/invite-email",
        email: "  Friend@Example.COM ",
      },
      invitedBy: owner,
    });
    expect(first.email).toBe("friend@example.com");

    const second = await admin.inviteEmail({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "access/invite-email",
        email: "friend@example.com",
      },
      invitedBy: "someone.else@example.com",
    });
    expect(second).toEqual(first);
    expect(host.recorded.invitations.size).toBe(1);
  });

  test("a malformed address never reaches the authority", async () => {
    const host = memoryHost();
    const admin = createAdminOperationsV1(host);

    await expect(
      admin.inviteEmail({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "access/invite-email",
          email: "not-an-address",
        },
        invitedBy: owner,
      }),
    ).rejects.toThrow("invalid");
    expect(host.recorded.invitations.size).toBe(0);
  });
});

describe("the account list", () => {
  test("carries each account's features, credit and access record", async () => {
    const host = memoryHost([
      { userId: "one", email: "one@example.com", name: "One" },
      { userId: "two" },
    ]);
    const admin = createAdminOperationsV1(host, catalog);
    await admin.setAccountAccess({
      schemaVersion: 1,
      userId: "one",
      command: {
        schemaVersion: 1,
        type: "account/set-access",
        state: "active",
        revision: 0,
      },
      updatedBy: owner,
    });

    const view = await admin.listAccounts();

    expect(view.users.map((user) => user.userId)).toEqual(["one", "two"]);
    const [first, second] = view.users;
    expect(
      isAccountAccessUnavailable(first!.access)
        ? undefined
        : first!.access.access,
    ).toMatchObject({ state: "active", revision: 1 });
    expect(
      isAccountAccessUnavailable(second!.access)
        ? undefined
        : second!.access.access,
    ).toBeNull();
    expect(
      isUserFeaturesUnavailable(first!.features)
        ? undefined
        : first!.features.pluginAuthoring,
    ).toBe(false);
    // Only the admin-gated entries: an account is never offered a Plugin the
    // catalog already seeds for everyone.
    expect(view.gatedPlugins).toEqual([
      { pluginId: "gated-plugin", displayName: "The gated-plugin plugin" },
    ]);
  });

  test("one unreadable account is marked unreadable and hides no other", async () => {
    const host = memoryHost([{ userId: "wedged" }, { userId: "fine" }], {
      unreadableFeatures: new Set(["wedged"]),
      unreadableAccess: new Set(["wedged"]),
    });
    const admin = createAdminOperationsV1(host);

    const { users } = await admin.listAccounts();

    expect(users.map((user) => user.userId)).toEqual(["wedged", "fine"]);
    expect(isUserFeaturesUnavailable(users[0]!.features)).toBe(true);
    expect(isAccountAccessUnavailable(users[0]!.access)).toBe(true);
    expect(isUserFeaturesUnavailable(users[1]!.features)).toBe(false);
    expect(isAccountAccessUnavailable(users[1]!.access)).toBe(false);
  });
});

describe("an account's features", () => {
  test("open an admin-gated Plugin and keep the other switches", async () => {
    const host = memoryHost([{ userId: "guest" }]);
    const admin = createAdminOperationsV1(host, catalog);

    const written = await admin.setAccountFeatures({
      schemaVersion: 1,
      userId: "guest",
      command: {
        schemaVersion: 1,
        type: "user/set-features",
        pluginAuthoring: true,
        plugins: ["gated-plugin"],
      },
      updatedBy: owner,
    });

    expect(written).toMatchObject({
      pluginAuthoring: true,
      plugins: ["gated-plugin"],
      updatedBy: owner,
    });
  });

  test("a Plugin id the catalog does not gate is refused, not stored", async () => {
    const host = memoryHost([{ userId: "guest" }]);
    const admin = createAdminOperationsV1(host, catalog);

    await expect(
      admin.setAccountFeatures({
        schemaVersion: 1,
        userId: "guest",
        command: {
          schemaVersion: 1,
          type: "user/set-features",
          plugins: ["open-plugin"],
        },
        updatedBy: owner,
      }),
    ).rejects.toThrow("admin-gated");
    expect(host.recorded.features.size).toBe(0);
  });

  test("a malformed command never reaches the account", async () => {
    const host = memoryHost([{ userId: "guest" }]);
    const admin = createAdminOperationsV1(host, catalog);

    await expect(
      admin.setAccountFeatures({
        schemaVersion: 1,
        userId: "guest",
        command: { schemaVersion: 1, type: "user/oops" } as never,
        updatedBy: owner,
      }),
    ).rejects.toThrow();
    expect(host.recorded.features.size).toBe(0);
  });
});

describe("credit an administrator grants by hand", () => {
  test("lands once per id, however many times the request arrives", async () => {
    const host = memoryHost([{ userId: "guest" }]);
    const admin = createAdminOperationsV1(host);
    const request = {
      schemaVersion: 1,
      userId: "guest",
      command: {
        schemaVersion: 1,
        type: "user/grant-credit",
        id: "grant-1",
        cents: 2_500,
        reason: "Beta thanks",
      },
      grantedBy: owner,
    };

    const first = await admin.grantCredit(request);
    const second = await admin.grantCredit(request);

    expect(first.complimentaryMicros).toBe(25_000_000);
    expect(second).toEqual(first);
    expect(host.recorded.grants).toEqual([
      { userId: "guest", id: "grant-1", cents: 2_500, by: owner },
    ]);
  });

  test("an amount past the cap is refused before the ledger", async () => {
    const host = memoryHost([{ userId: "guest" }]);
    const admin = createAdminOperationsV1(host);

    await expect(
      admin.grantCredit({
        schemaVersion: 1,
        userId: "guest",
        command: {
          schemaVersion: 1,
          type: "user/grant-credit",
          id: "grant-2",
          cents: 100_001,
          reason: "Slipped digit",
        },
        grantedBy: owner,
      }),
    ).rejects.toThrow();
    expect(host.recorded.grants).toEqual([]);
  });
});

describe("the gated catalog", () => {
  test("is the admin-gated seeded Plugins and nothing else", () => {
    expect(adminGatedPluginsV1(catalog)).toEqual([
      { pluginId: "gated-plugin", displayName: "The gated-plugin plugin" },
    ]);
    // This deployment seeds none yet, so nothing is offered.
    expect(adminGatedPluginsV1()).toEqual([]);
  });
});
