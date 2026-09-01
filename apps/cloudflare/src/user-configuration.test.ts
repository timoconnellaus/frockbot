import { describe, expect, mock, test } from "bun:test";
import type { WorkerLoader } from "./contracts.js";

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

const { UserConfiguration } = await import("./user-configuration.js");

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, value);
    else
      for (const [entry, stored] of Object.entries(key))
        this.values.set(entry, stored);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(null);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The identity a User Durable Object is addressed by. Production binds the
 * object's own namespace and the object proves it is the User an RPC names by
 * deriving that id and comparing it with its own, so a test that leaves the
 * binding out is testing an object that cannot know who it is.
 */
function identity(userId: string): {
  ctx: (storage: unknown) => DurableObjectState;
  env: {
    USER_CONFIGURATIONS: DurableObjectNamespace;
    APPLICATION_ARTIFACTS: R2Bucket;
    USER_APPLICATIONS: WorkerLoader;
    BOT_STATES: DurableObjectNamespace;
  };
} {
  const idFor = (name: string) =>
    ({
      name,
      equals: (other: { name?: string }) => other?.name === name,
      toString: () => name,
    }) as unknown as DurableObjectId;
  return {
    ctx: (storage: unknown) =>
      ({ storage, id: idFor(userId) }) as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: idFor,
      } as unknown as DurableObjectNamespace,
      // Publication bytes and the verification loader are not exercised here;
      // reaching either is a failure, not a fixture.
      APPLICATION_ARTIFACTS: {
        put: () => Promise.reject(new Error("no publication in this test")),
        get: () => Promise.reject(new Error("no publication in this test")),
      } as unknown as R2Bucket,
      USER_APPLICATIONS: {
        get: () => {
          throw new Error("no publication in this test");
        },
      } as unknown as WorkerLoader,
      // Bot lifecycle commands are carried to the Bot Durable Object; reaching
      // it is a failure, not a fixture.
      BOT_STATES: {
        idFromName: idFor,
        get: () => {
          throw new Error("no Bot lifecycle in this test");
        },
      } as unknown as DurableObjectNamespace,
    },
  };
}

const credentialKeyring =
  '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';

describe("UserConfiguration Connection routing", () => {
  test("reports provisioning without pinning a first-time User", async () => {
    const bound = identity("new-user");
    const configuration = new UserConfiguration(
      bound.ctx(new MemoryStorage()),
      { ...bound.env, CREDENTIAL_KEYRING: credentialKeyring },
    );

    await expect(
      configuration.isProvisioned({
        schemaVersion: 1,
        userId: "new-user",
      }),
    ).resolves.toBe(false);
    await configuration.readConfiguration({
      schemaVersion: 1,
      userId: "new-user",
    });
    await expect(
      configuration.isProvisioned({
        schemaVersion: 1,
        userId: "new-user",
      }),
    ).resolves.toBe(true);
  });

  test("mounts declared User Contributions through the application registry", async () => {
    const bound = identity("user-1");
    const configuration = new UserConfiguration(
      bound.ctx(new MemoryStorage()),
      {
        ...bound.env,
        CREDENTIAL_KEYRING: credentialKeyring,
      },
    );

    const first = await configuration.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(first).toMatchObject({
      schemaVersion: 1,
      revision: 3,
      connections: [
        expect.objectContaining({
          connectionId: "workers-ai-ambient",
          providerType: "workers-ai",
          state: "ready",
        }),
      ],
      newBotModelTemplate: {
        connectionId: "workers-ai-ambient",
        providerModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      },
      newBotModelTemplateSource: "auto",
    });
    expect(first.packages).toContainEqual(
      expect.objectContaining({
        packageId: "provider-workers-ai",
        state: "installed",
      }),
    );
    expect(first.packages.length).toBeGreaterThan(0);
    expect(
      first.packages.every(
        (pkg) => pkg.state === "installed" && pkg.provenance === "first-party",
      ),
    ).toBe(true);
    expect(first.packages.map((pkg) => pkg.packageId)).toContain("web");
  });
  test("dispatches a Connection command to the Package the User Contribution adjudicates", async () => {
    const executed: unknown[] = [];
    const resolved: unknown[] = [];
    const contribution = {
      packageId: "provider-ollama-cloud",
      lookupConnectionCommand: () => Promise.resolve(undefined),
      executeConnection: (_accountId: string, command: unknown) => {
        executed.push(command);
        return Promise.resolve({
          schemaVersion: 1,
          commandId: "disconnect-1",
          connectionId: "connection-revoked",
          status: "applied",
        });
      },
    };
    const bound = identity("user-1");
    const configuration = new UserConfiguration(bound.ctx({}), bound.env);
    Reflect.set(
      configuration,
      "mounted",
      Promise.resolve({
        settings: {
          resolveConnectionCommandOwner: (
            _userId: string,
            command: unknown,
          ) => {
            resolved.push(command);
            return Promise.resolve(contribution.packageId);
          },
        },
        credentials: {},
        connections: new Map([[contribution.packageId, contribution]]),
        flock: {},
        dispose: () => Promise.resolve(),
      }),
    );

    await expect(
      configuration.executeConnection({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "connection/disconnect",
          commandId: "disconnect-1",
          connectionId: "connection-revoked",
          revokeUpstream: false,
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(resolved).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });
});

describe("UserConfiguration Connection dependency protocol", () => {
  /**
   * The Bot's Assignment saga acknowledges a claim it reads back as
   * "claimed". A durable dependency that is recorded but not yet acknowledged
   * must therefore report "claimed", not "pending": reporting "pending" tells
   * the saga the User authority cannot answer, and it compensates a claim it
   * is entitled to keep, so no Assignment ever settles.
   */
  test("reads a recorded, unacknowledged dependency as claimed", async () => {
    const bound = identity("user-1");
    const configuration = new UserConfiguration(
      bound.ctx(new MemoryStorage()),
      bound.env,
    );
    let state: "absent" | "pending" | "acknowledged" = "pending";
    Reflect.set(
      configuration,
      "mounted",
      Promise.resolve({
        settings: {
          getConnection: () =>
            Promise.resolve({
              connectionId: "connection-1",
              packageId: "provider-ollama-cloud",
              connectionTypeId: "ollama-cloud-account",
              displayName: "Work",
              state: "ready",
              safeMetadata: {},
            }),
          readConnectionDependency: () => Promise.resolve(state),
          acknowledgeConnectionDependency: () => {
            state = "acknowledged";
            return Promise.resolve(true);
          },
        },
        credentials: {},
        connections: new Map(),
        flock: {},
        dispose: () => Promise.resolve(),
      }),
    );
    const command = (action: "read" | "acknowledge") => ({
      schemaVersion: 1 as const,
      action,
      operationId: "operation-1",
      userId: "user-1",
      packageId: "provider-ollama-cloud",
      connectionId: "connection-1",
      botId: "primary",
      generation: "generation-1",
    });

    await expect(
      configuration.executeConnectionDependency(command("read")),
    ).resolves.toEqual({ schemaVersion: 1, status: "claimed" });
    await expect(
      configuration.executeConnectionDependency(command("acknowledge")),
    ).resolves.toEqual({ schemaVersion: 1, status: "acknowledged" });
    await expect(
      configuration.executeConnectionDependency(command("read")),
    ).resolves.toEqual({ schemaVersion: 1, status: "acknowledged" });

    state = "absent";
    await expect(
      configuration.executeConnectionDependency(command("read")),
    ).resolves.toEqual({ schemaVersion: 1, status: "absent" });
  });
});
