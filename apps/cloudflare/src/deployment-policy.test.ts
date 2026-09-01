import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    readonly ctx: DurableObjectState;
    readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { DeploymentPolicy } = await import("./deployment-policy.js");

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function authority(): InstanceType<typeof DeploymentPolicy> {
  return new DeploymentPolicy(
    { storage: new MemoryStorage() } as unknown as DurableObjectState,
    {},
  );
}

describe("DeploymentPolicy", () => {
  test("defaults to closed and persists an optimistic update", async () => {
    const policy = authority();
    const initial = await policy.readPolicy({ schemaVersion: 1 });
    expect(initial).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      signups: { open: false },
      updatedBy: "deployment-default",
    });

    const opened = await policy.setSignups({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: 0,
      },
      updatedBy: "owner-id",
    });
    expect(opened).toMatchObject({
      revision: 1,
      signups: { open: true },
      updatedBy: "owner-id",
    });
    expect(await policy.readPolicy({ schemaVersion: 1 })).toEqual(opened);
  });

  test("rejects stale revisions without changing the policy", async () => {
    const policy = authority();
    await policy.setSignups({
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: 0,
      },
      updatedBy: "owner-id",
    });

    await expect(
      policy.setSignups({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: false,
          revision: 0,
        },
        updatedBy: "owner-id",
      }),
    ).rejects.toMatchObject({
      name: "DeploymentPolicyConflictError",
      currentRevision: 1,
    });
    expect(await policy.readPolicy({ schemaVersion: 1 })).toMatchObject({
      revision: 1,
      signups: { open: true },
    });
  });
});
