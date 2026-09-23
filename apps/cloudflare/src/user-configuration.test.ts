import { describe, expect, mock, test } from "bun:test";
import {
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import type { WorkerLoader } from "./contracts.js";
import { randomAvatarAppearanceV1 } from "@frockbot/app/flock/shared";
import { FOUNDATION_PACKAGE_CATALOG_V1 } from "@frockbot/app/packages";

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

  delete(key: string | string[]): Promise<boolean | number> {
    if (typeof key === "string")
      return Promise.resolve(this.values.delete(key));
    let deleted = 0;
    for (const entry of key) if (this.values.delete(entry)) deleted += 1;
    return Promise.resolve(deleted);
  }

  list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) {
    return Promise.resolve(
      new Map(
        [...this.values]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit),
      ),
    );
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
    // The constructor's disposable panel cleanup is exercised against real
    // storage in integration tests; these fakes hold none.
    ctx: (storage: unknown) =>
      ({
        storage,
        id: idFor(userId),
        blockConcurrencyWhile: (body: () => Promise<unknown>) => {
          const run =
            typeof (storage as { transaction?: unknown }).transaction ===
            "function"
              ? body()
              : Promise.resolve();
          (
            storage as { constructorReady?: Promise<unknown> }
          ).constructorReady = run;
          return run;
        },
      }) as unknown as DurableObjectState,
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
  test("a Profile timezone update is projected to every owned Bot", async () => {
    const userId = "timezone-user";
    const storage = new MemoryStorage();
    await storage.put("flock:directory:v1", {
      schemaVersion: 1,
      revision: 1,
      bots: [
        {
          schemaVersion: 1,
          botId: "scout",
          registeredAt: "2026-09-10T00:00:00.000Z",
          initialName: "Scout",
          avatar: randomAvatarAppearanceV1(() => 0),
        },
      ],
    });
    const projected: unknown[] = [];
    const bound = identity(userId);
    bound.env.BOT_STATES = {
      ...bound.env.BOT_STATES,
      get: () => ({
        refreshRoutineTimezone(input: unknown) {
          projected.push(input);
          return Promise.resolve({ schemaVersion: 1, status: "applied" });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const configuration = new UserConfiguration(bound.ctx(storage), {
      ...bound.env,
      CREDENTIAL_KEYRING: credentialKeyring,
    });
    const current = await configuration.readConfiguration({
      schemaVersion: 1,
      view: 2,
      userId,
    });

    await configuration.executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "set-timezone",
        expectedRevision: current.revision,
        profile: { name: "Tim", timezone: "Australia/Sydney" },
      },
    });

    expect(projected).toEqual([
      {
        schemaVersion: 1,
        userId,
        botId: "scout",
        timezone: "Australia/Sydney",
        revision: current.revision + 1,
      },
    ]);
  });

  test("a save that moved no zone fans out to nothing, and a Bot that refuses does not fail it", async () => {
    const userId = "timezone-user-2";
    const storage = new MemoryStorage();
    await storage.put("flock:directory:v1", {
      schemaVersion: 1,
      revision: 1,
      bots: [
        {
          schemaVersion: 1,
          botId: "scout",
          registeredAt: "2026-09-10T00:00:00.000Z",
          initialName: "Scout",
          avatar: randomAvatarAppearanceV1(() => 0),
        },
      ],
    });
    let calls = 0;
    const bound = identity(userId);
    bound.env.BOT_STATES = {
      ...bound.env.BOT_STATES,
      get: () => ({
        refreshRoutineTimezone() {
          calls += 1;
          return Promise.reject(new Error("the Bot object is unreachable"));
        },
      }),
    } as unknown as DurableObjectNamespace;
    const configuration = new UserConfiguration(bound.ctx(storage), {
      ...bound.env,
      CREDENTIAL_KEYRING: credentialKeyring,
    });
    const current = await configuration.readConfiguration({
      schemaVersion: 1,
      view: 2,
      userId,
    });

    // A name-only edit bumps the revision and moves no zone.
    const named = await configuration.executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "set-name",
        expectedRevision: current.revision,
        profile: { name: "Tim" },
      },
    });
    expect(named.status).toBe("applied");
    expect(calls).toBe(0);

    // The zone moves, the one Bot refuses the push, and the save still stands:
    // the mount re-projects the zone on the Bot's next Turn.
    const zoned = await configuration.executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "set-timezone",
        expectedRevision: current.revision + 1,
        profile: { name: "Tim", timezone: "Australia/Sydney" },
      },
    });
    expect(zoned.status).toBe("applied");
    expect(calls).toBe(1);
    expect(
      (
        await configuration.readConfiguration({
          schemaVersion: 1,
          view: 2,
          userId,
        })
      ).profile.timezone,
    ).toBe("Australia/Sydney");
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
      view: 2,
      userId: "user-1",
    });
    expect(first).toMatchObject({
      schemaVersion: 1,
      revision: 3,
      connections: [
        expect.objectContaining({
          connectionId: "flock-ai-ambient",
          providerType: "flock-ai",
          state: "ready",
        }),
      ],
      platformModel: {
        connectionId: "flock-ai-ambient",
        providerModelId: "@frock/auto",
      },
    });
    expect(first.packages).toContainEqual(
      expect.objectContaining({
        packageId: "provider-flock-ai",
        state: "installed",
      }),
    );
    expect(first.packages.length).toBeGreaterThan(0);
    expect(
      first.packages.every((pkg) => pkg.provenance === "first-party"),
    ).toBe(true);
    expect(first.packages).toContainEqual(
      expect.objectContaining({
        packageId: "provider-ollama-cloud",
        state: "disabled",
      }),
    );
    // Frock AI is the one model provider a new account has: every other one
    // is the account's to add from the Marketplace.
    const modelProviders = new Set(
      FOUNDATION_PACKAGE_CATALOG_V1.entries
        .filter((pkg) =>
          pkg.capabilities?.some((capability) => capability.kind === "model"),
        )
        .map((pkg) => pkg.id),
    );
    expect(
      first.packages
        .filter(
          (pkg) =>
            modelProviders.has(pkg.packageId) && pkg.state === "installed",
        )
        .map((pkg) => pkg.packageId),
    ).toEqual(["provider-flock-ai"]);
    expect(first.packages.map((pkg) => pkg.packageId)).toContain("web");
  });

  test("the Marketplace catalog offers a Plugin-served provider only where a Plugin can run", async () => {
    const userId = "marketplace-user";
    const storage = new MemoryStorage();
    const bound = identity(userId);
    const catalog = async (env: Record<string, unknown>) =>
      (
        await new UserConfiguration(bound.ctx(storage), {
          ...bound.env,
          ...env,
          CREDENTIAL_KEYRING: credentialKeyring,
        }).readConnectionsFrame({ schemaVersion: 1, userId, catalog: true })
      ).providers.map((provider) => provider.packageId);
    expect(await catalog({})).not.toContain("provider-deepseek");
    const withLoader = await catalog({
      BOT_PACKAGES: { get: () => ({}) } as never,
    });
    expect(withLoader).toContain("provider-deepseek");
    expect(withLoader).toContain("provider-openai");
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

describe("UserConfiguration alarm", () => {
  /**
   * Everything the alarm calls, with the import recovery half recorded. An
   * alarm has no caller, so this is the whole of what a woken object can rely
   * on: its own storage and its own id.
   */
  function mountedFor(recovered: string[]) {
    return Promise.resolve({
      credentials: { expireLeases: () => Promise.resolve() },
      connections: new Map(),
      publisher: { recover: () => Promise.resolve() },
      botTemplate: {
        recoverImports: (userId: string) => {
          recovered.push(userId);
          return Promise.resolve();
        },
      },
      flock: {
        alarm: () => Promise.resolve(),
        listBotLifecycles: () => Promise.resolve({ lifecycles: [] }),
        listDeletedBotIds: () => Promise.resolve([]),
      },
      search: { purge: () => {} },
      audit: { purgeAuditForBot: () => {} },
    });
  }

  test("recovers imports for the identity pinned in storage, with no prior RPC", async () => {
    const bound = identity("evicted-user");
    const storage = new MemoryStorage();
    // What an authenticated RPC left behind before the object was evicted.
    await storage.put("user:identity", "evicted-user");
    const configuration = new UserConfiguration(bound.ctx(storage), bound.env);
    const recovered: string[] = [];
    Reflect.set(configuration, "mounted", mountedFor(recovered));

    // A fresh instance woken by its own alarm: no RPC has run on it.
    await configuration.alarm();

    expect(recovered).toEqual(["evicted-user"]);
  });

  test("runs no User-scoped recovery for an object with no pinned identity", async () => {
    const bound = identity("never-provisioned");
    const configuration = new UserConfiguration(
      bound.ctx(new MemoryStorage()),
      bound.env,
    );
    const recovered: string[] = [];
    Reflect.set(configuration, "mounted", mountedFor(recovered));

    await configuration.alarm();

    expect(recovered).toEqual([]);
  });

  test("refuses a pin that does not derive to this object's own id", async () => {
    const bound = identity("this-user");
    const storage = new MemoryStorage();
    // A pin naming someone else can only be corruption: the namespace check is
    // what makes the pin trustworthy, and it is applied to the alarm too.
    await storage.put("user:identity", "some-other-user");
    const configuration = new UserConfiguration(bound.ctx(storage), bound.env);
    const recovered: string[] = [];
    Reflect.set(configuration, "mounted", mountedFor(recovered));

    await configuration.alarm();

    expect(recovered).toEqual([]);
  });
});

describe("UserConfiguration constructor cleanup", () => {
  test("constructor cleanup removes a retired default-Package marker before the first read", async () => {
    const userId = "retired-marker-user";
    const storage = new MemoryStorage();
    await storage.put("user-id", userId);
    await storage.put("user-default-packages-bootstrap:v1", {
      schemaVersion: 2,
    });
    const bound = identity(userId);
    const configuration = new UserConfiguration(bound.ctx(storage), {
      ...bound.env,
      CREDENTIAL_KEYRING: credentialKeyring,
    });
    await (storage as { constructorReady?: Promise<unknown> }).constructorReady;
    expect(
      await storage.get("user-default-packages-bootstrap:v1"),
    ).toBeUndefined();
    const user = await configuration.readConfiguration({
      schemaVersion: 1,
      view: 2,
      userId,
    });
    expect(user.packages.length).toBeGreaterThan(0);
    const marker = await storage.get<{
      schemaVersion: number;
      seededPackageIds: string[];
    }>("user-default-packages-bootstrap:v1");
    expect(marker?.schemaVersion).toBe(4);
    expect(Array.isArray(marker?.seededPackageIds)).toBe(true);
    expect(marker?.seededPackageIds.length).toBeGreaterThan(0);
  });
});
