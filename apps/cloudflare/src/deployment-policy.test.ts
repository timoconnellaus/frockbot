import { describe, expect, mock, test } from "bun:test";

// `mock.module` is process-global and the first registration in a suite run
// fixes the module's shape, so this stub has to satisfy every consumer the run
// loads — not only this file's. `@cloudflare/containers` imports both names.
mock.module("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    readonly ctx: DurableObjectState;
    readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class<Env> {
    readonly ctx: unknown;
    readonly env: Env;

    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const {
  DeploymentPolicy,
  RETIRED_SIGNUPS_POLICY_KEY,
  RETIRED_SIGNUPS_POLICY_RECEIPT_KEY,
} = await import("./deployment-policy.js");

/**
 * The SQLite-backed synchronous key-value API the object uses, with a
 * transaction that really rolls back: a decision that throws halfway must
 * leave nothing behind.
 */
class MemoryStorage {
  values = new Map<string, unknown>();
  readonly kv = {
    get: <T>(key: string): T | undefined =>
      structuredClone(this.values.get(key)) as T | undefined,
    put: (key: string, value: unknown): void => {
      this.values.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.values.delete(key),
  };

  transactionSync<T>(callback: () => T): T {
    const before = new Map(this.values);
    try {
      return callback();
    } catch (error) {
      this.values = before;
      throw error;
    }
  }
}

/** One object over one storage, as a restart would reconstruct it. */
function authority(storage = new MemoryStorage()) {
  const policy = new DeploymentPolicy(
    {
      storage,
      blockConcurrencyWhile: async (callback: () => Promise<unknown>) =>
        callback(),
    } as unknown as DurableObjectState,
    {},
  );
  return { policy, storage };
}

const member = (userId: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  userId,
  email: `${userId}@example.com`,
  emailVerified: true,
  isAdmin: false,
  ...overrides,
});

async function setMode(
  policy: InstanceType<typeof DeploymentPolicy>,
  mode: "closed" | "invite-only" | "open",
) {
  const current = await policy.readPolicy({ schemaVersion: 1 });
  const write = await policy.setAdmissionMode({
    schemaVersion: 1,
    command: {
      schemaVersion: 1,
      type: "deployment/set-admission-mode",
      mode,
      revision: current.revision,
    },
    updatedBy: "owner-id",
  });
  if (write.status !== "applied") throw new Error("mode write conflicted");
  return write.value;
}

async function setAccess(
  policy: InstanceType<typeof DeploymentPolicy>,
  userId: string,
  state: "invited" | "active" | "paused" | "ended" | "blocked",
  revision?: number,
) {
  const current = await policy.readAccountAccess({ schemaVersion: 1, userId });
  return policy.setAccountAccess({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "account/set-access",
      state,
      revision: revision ?? current.access?.revision ?? 0,
    },
    updatedBy: "owner-id",
  });
}

describe("DeploymentPolicy", () => {
  test("defaults to closed and persists an optimistic mode change", async () => {
    const { policy, storage } = authority();
    const initial = await policy.readPolicy({ schemaVersion: 1 });
    expect(initial).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      admission: { mode: "closed" },
      updatedBy: "deployment-default",
    });
    const opened = await setMode(policy, "invite-only");
    expect(opened).toMatchObject({
      revision: 1,
      admission: { mode: "invite-only" },
      updatedBy: "owner-id",
    });
    // Reconstructed from storage, not held in memory.
    expect(
      await authority(storage).policy.readPolicy({ schemaVersion: 1 }),
    ).toEqual(opened);
  });

  test("a stale mode revision is a conflict answer and changes nothing", async () => {
    const { policy } = authority();
    await setMode(policy, "open");
    expect(
      await policy.setAdmissionMode({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "deployment/set-admission-mode",
          mode: "closed",
          revision: 0,
        },
        updatedBy: "owner-id",
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    expect(await policy.readPolicy({ schemaVersion: 1 })).toMatchObject({
      revision: 1,
      admission: { mode: "open" },
    });
  });

  test("a User that exists elsewhere is not admitted here", async () => {
    const { policy, storage } = authority();
    expect(await policy.admitAccount(member("existing"))).toEqual({
      schemaVersion: 1,
      admitted: false,
      reason: "admission-closed",
    });
    await setMode(policy, "invite-only");
    expect(await policy.admitAccount(member("existing"))).toMatchObject({
      reason: "invitation-required",
    });
    // A refusal writes no record.
    expect(
      [...storage.values.keys()].filter((k) => k.startsWith("account:")),
    ).toEqual([]);
  });

  test("open admission activates durably, and closing it keeps active accounts", async () => {
    const { policy, storage } = authority();
    await setMode(policy, "open");
    expect(await policy.admitAccount(member("early"))).toEqual({
      schemaVersion: 1,
      admitted: true,
      basis: "open",
    });
    expect(
      (await policy.readAccountAccess({ schemaVersion: 1, userId: "early" }))
        .access,
    ).toMatchObject({ state: "active", revision: 1, updatedBy: "admission" });
    await setMode(policy, "closed");
    const restarted = authority(storage).policy;
    expect(await restarted.admitAccount(member("early"))).toMatchObject({
      admitted: true,
      basis: "active",
    });
    expect(await restarted.admitAccount(member("late"))).toMatchObject({
      admitted: false,
      reason: "admission-closed",
    });
  });

  test("paused, ended and blocked beat open mode, and admission never lifts them", async () => {
    const { policy } = authority();
    await setMode(policy, "open");
    for (const [state, reason] of [
      ["paused", "account-paused"],
      ["ended", "account-ended"],
      ["blocked", "account-blocked"],
    ] as const) {
      const userId = `held-${state}`;
      expect(await setAccess(policy, userId, state)).toMatchObject({
        status: "applied",
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await policy.admitAccount(member(userId))).toMatchObject({
          admitted: false,
          reason,
        });
      }
      expect(
        (await policy.readAccountAccess({ schemaVersion: 1, userId })).access,
      ).toMatchObject({ state, revision: 1 });
    }
  });

  test("revoking an active account takes effect on its next admission", async () => {
    const { policy } = authority();
    await setMode(policy, "open");
    await policy.admitAccount(member("u1"));
    expect(await setAccess(policy, "u1", "paused")).toMatchObject({
      status: "applied",
      value: { state: "paused", revision: 2 },
    });
    expect(await policy.admitAccount(member("u1"))).toMatchObject({
      reason: "account-paused",
    });
    await setAccess(policy, "u1", "active");
    expect(await policy.admitAccount(member("u1"))).toMatchObject({
      admitted: true,
      basis: "active",
    });
  });

  test("an admin's write that did not see an activation is a conflict, not an overwrite", async () => {
    const { policy } = authority();
    await setMode(policy, "invite-only");
    await setAccess(policy, "u1", "invited");
    // The admin read revision 1 (invited); the account activates meanwhile.
    expect(await policy.admitAccount(member("u1"))).toMatchObject({
      basis: "invitation",
    });
    expect(await setAccess(policy, "u1", "ended", 1)).toEqual({
      status: "conflict",
      currentRevision: 2,
    });
    // And the other order: the pause lands first, the stale sign-in cannot undo it.
    expect(await setAccess(policy, "u1", "paused", 2)).toMatchObject({
      status: "applied",
    });
    expect(await policy.admitAccount(member("u1"))).toMatchObject({
      reason: "account-paused",
    });
    expect(
      (await policy.readAccountAccess({ schemaVersion: 1, userId: "u1" }))
        .access,
    ).toMatchObject({ state: "paused", revision: 3 });
  });

  test("interleaved admissions and admin writes serialize to one outcome each", async () => {
    const { policy } = authority();
    await setMode(policy, "open");
    const answers = await Promise.all([
      policy.admitAccount(member("race")),
      setAccess(policy, "race", "blocked", 0),
      policy.admitAccount(member("race")),
    ]);
    const final = (
      await policy.readAccountAccess({ schemaVersion: 1, userId: "race" })
    ).access;
    // Whichever landed first, exactly one write won revision 1 and nothing
    // after it moved a blocked account back to active.
    if (answers[1].status === "applied") {
      expect(final).toMatchObject({ state: "blocked" });
      expect(answers[2]).toMatchObject({ reason: "account-blocked" });
    } else {
      expect(answers[0]).toMatchObject({ admitted: true, basis: "open" });
      expect(final).toMatchObject({ state: "active", revision: 1 });
    }
  });

  test("an invitation binds only to a verified address, once", async () => {
    const { policy } = authority();
    await setMode(policy, "invite-only");
    await policy.inviteEmail({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "access/invite-email",
        email: "Friend@Example.com",
      },
      invitedBy: "owner-id",
    });
    expect(
      await policy.mayCreateIdentity({
        schemaVersion: 1,
        email: "friend@example.com",
        emailVerified: false,
        isAdmin: false,
      }),
    ).toBe(false);
    expect(
      await policy.admitAccount(
        member("squatter", {
          email: "friend@example.com",
          emailVerified: false,
        }),
      ),
    ).toMatchObject({ reason: "invitation-required" });
    expect(
      await policy.mayCreateIdentity({
        schemaVersion: 1,
        email: "FRIEND@example.com",
        emailVerified: true,
        isAdmin: false,
      }),
    ).toBe(true);
    expect(
      await policy.admitAccount(
        member("friend", { email: "friend@example.com" }),
      ),
    ).toMatchObject({ admitted: true, basis: "invitation" });
    // Spent: a second identity with the same verified address gets nothing.
    expect(
      await policy.admitAccount(
        member("second", { email: "friend@example.com" }),
      ),
    ).toMatchObject({ reason: "invitation-required" });
    expect(
      await policy.mayCreateIdentity({
        schemaVersion: 1,
        email: "friend@example.com",
        emailVerified: true,
        isAdmin: false,
      }),
    ).toBe(false);
  });

  test("closing admission keeps an invitation for later rather than spending it", async () => {
    const { policy } = authority();
    await policy.inviteEmail({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "access/invite-email",
        email: "later@example.com",
      },
      invitedBy: "owner-id",
    });
    expect(await policy.admitAccount(member("later"))).toMatchObject({
      reason: "admission-closed",
    });
    await setMode(policy, "invite-only");
    expect(await policy.admitAccount(member("later"))).toMatchObject({
      basis: "invitation",
    });
  });

  test("an admin is admitted without a record, even over a block", async () => {
    const { policy, storage } = authority();
    await setAccess(policy, "owner", "blocked");
    expect(
      await policy.admitAccount(member("owner", { isAdmin: true })),
    ).toEqual({ schemaVersion: 1, admitted: true, basis: "admin" });
    expect(
      (await policy.readAccountAccess({ schemaVersion: 1, userId: "owner" }))
        .access?.revision,
    ).toBe(1);
    expect(storage.values.size).toBeGreaterThan(0);
  });

  test("malformed requests are refused before any decision", async () => {
    const { policy, storage } = authority();
    const before = new Map(storage.values);
    await expect(
      policy.admitAccount({ schemaVersion: 1, userId: "u1", isAdmin: true }),
    ).rejects.toThrow("unknown fields");
    await expect(
      policy.setAccountAccess({
        schemaVersion: 1,
        userId: "u1",
        command: {
          schemaVersion: 1,
          type: "account/set-access",
          state: "trial",
          revision: 0,
        },
        updatedBy: "owner-id",
      }),
    ).rejects.toThrow("invalid");
    expect(storage.values).toEqual(before);
  });

  test("a stored record that does not decode fails closed instead of admitting", async () => {
    const { policy, storage } = authority();
    await setMode(policy, "open");
    storage.values.set("account:access:v1:u1", { state: "active" });
    await expect(policy.admitAccount(member("u1"))).rejects.toThrow();
    expect(storage.values.get("account:access:v1:u1")).toEqual({
      state: "active",
    });
  });
});

describe("retired signups policy cleanup", () => {
  test("deletes exactly the retired record, once, and a restart repeats nothing", async () => {
    const storage = new MemoryStorage();
    storage.values.set(RETIRED_SIGNUPS_POLICY_KEY, {
      schemaVersion: 1,
      revision: 7,
      signups: { open: true },
      updatedAt: "2026-09-01T00:00:00.000Z",
      updatedBy: "owner-id",
    });
    storage.values.set("account:access:v1:kept", {
      schemaVersion: 1,
      userId: "kept",
      state: "active",
      revision: 1,
      updatedAt: "2026-09-01T00:00:00.000Z",
      updatedBy: "owner-id",
    });
    const { policy } = authority(storage);
    expect(storage.values.has(RETIRED_SIGNUPS_POLICY_KEY)).toBe(false);
    expect(
      storage.values.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY),
    ).toMatchObject({
      deleted: 1,
    });
    // The open switch is not carried forward: the new authority starts closed.
    expect(await policy.readPolicy({ schemaVersion: 1 })).toMatchObject({
      revision: 0,
      admission: { mode: "closed" },
    });
    expect(await policy.admitAccount(member("kept"))).toMatchObject({
      basis: "active",
    });

    const receipt = storage.values.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY);
    const snapshot = new Map(storage.values);
    authority(storage);
    authority(storage);
    expect(storage.values).toEqual(snapshot);
    expect(storage.values.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY)).toEqual(
      receipt,
    );
  });

  test("a fresh deployment records that there was nothing to delete", () => {
    const storage = new MemoryStorage();
    authority(storage);
    expect(
      storage.values.get(RETIRED_SIGNUPS_POLICY_RECEIPT_KEY),
    ).toMatchObject({
      deleted: 0,
    });
  });
});
