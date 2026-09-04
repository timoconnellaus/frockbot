import { describe, expect, mock, test } from "bun:test";
import {
  compileFoundationApplication,
  isPlatformOwnedPackageV1,
} from "@frockbot/application-foundation/runtime";
import {
  decodeBotSettingsViewV1,
  migrateStoredBotSettingsV1,
  resolveEffectiveBotModelV1,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { WorkerLoader } from "./contracts.js";
import {
  LEGACY_DEFAULT_PACKAGES_MARKER_KEY,
  LEGACY_OLLAMA_CONNECTION_ID,
  LEGACY_OLLAMA_MODEL_ID,
  LEGACY_SETTINGS_STATE_KEY,
  legacyBotSettingsRecordV1,
  legacyDefaultPackagesMarkerV1,
  legacyUserSettingsRecordV1,
} from "../test/legacy-model-account.js";
import {
  PRODUCTION_CATALOG_PIN_KEY,
  PRODUCTION_DEFAULT_PACKAGES_MARKER_KEY,
  PRODUCTION_FLOCK_BOOTSTRAP_MARKER_KEY,
  PRODUCTION_SETTINGS_STATE_KEY,
  PRODUCTION_OLLAMA_CONNECTION_ID,
  PRODUCTION_OLLAMA_MODEL_ID,
  productionCatalogPinV1,
  productionDefaultPackagesMarkerV2,
  productionFlockBootstrapMarkerV1,
  productionUserSettingsRecordV1,
} from "../test/production-model-account.js";

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

async function executionPackages() {
  return (await compileFoundationApplication()).packages.map((pkg) => ({
    packageId: pkg.id,
    version: pkg.version,
    settings: pkg.manifest.configuration?.settings ?? [],
    capabilities: pkg.manifest.configuration?.capabilities ?? [],
    connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
  }));
}

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
          connectionId: "flock-ai-ambient",
          providerType: "flock-ai",
          state: "ready",
        }),
      ],
      platformModel: {
        connectionId: "flock-ai-ambient",
        providerModelId: "@flock/auto",
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
    expect(first.packages.map((pkg) => pkg.packageId)).toContain("web");
  });

  test("repairs a legacy model account and preserves explicit model recovery", async () => {
    const userId = "legacy-model-user";
    const storage = new MemoryStorage();
    await storage.put({
      [LEGACY_SETTINGS_STATE_KEY]: legacyUserSettingsRecordV1(),
      [LEGACY_DEFAULT_PACKAGES_MARKER_KEY]: legacyDefaultPackagesMarkerV1(),
    });
    const bound = identity(userId);
    const configuration = new UserConfiguration(bound.ctx(storage), {
      ...bound.env,
      CREDENTIAL_KEYRING: credentialKeyring,
    });
    const packages = await executionPackages();
    const bot = decodeBotSettingsViewV1(
      migrateStoredBotSettingsV1(legacyBotSettingsRecordV1()),
    );

    let user = await configuration.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    expect(user.packages).not.toContainEqual(
      expect.objectContaining({ packageId: "provider-workers-ai" }),
    );
    expect(user.connections).not.toContainEqual(
      expect.objectContaining({ connectionId: "workers-ai-ambient" }),
    );
    expect(user.packages).toContainEqual(
      expect.objectContaining({
        packageId: "provider-ollama-cloud",
        state: "disabled",
      }),
    );
    expect(user.packages).toContainEqual(
      expect.objectContaining({
        packageId: "custom-models",
        state: "disabled",
      }),
    );
    expect(resolveEffectiveBotModelV1({ bot, user, packages })).toMatchObject({
      source: "platform",
      model: {
        connectionId: "flock-ai-ambient",
        providerModelId: "@flock/auto",
      },
      binding: { state: "ready", packageId: "provider-flock-ai" },
    });

    const execute = async (command: UserConfigurationCommandV1) => {
      const receipt = await configuration.executeConfiguration({
        schemaVersion: 1,
        userId,
        command,
      });
      expect(receipt.status).toBe("applied");
      user = (await configuration.readConfiguration({
        schemaVersion: 1,
        userId,
      })) as UserSettingsViewV1;
    };

    await execute({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "enable-custom-models",
      expectedRevision: user.revision,
      packageId: "custom-models",
      enabled: true,
    });
    await execute({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "enable-ollama",
      expectedRevision: user.revision,
      packageId: "provider-ollama-cloud",
      enabled: true,
    });
    await execute({
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: "choose-ollama",
      expectedRevision: user.revision,
      packageId: "custom-models",
      values: {
        "account-model": {
          connectionId: LEGACY_OLLAMA_CONNECTION_ID,
          providerModelId: LEGACY_OLLAMA_MODEL_ID,
        },
      },
    });
    expect(resolveEffectiveBotModelV1({ bot, user, packages })).toMatchObject({
      source: "account",
      binding: { state: "ready", packageId: "provider-ollama-cloud" },
    });

    await execute({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "disable-ollama",
      expectedRevision: user.revision,
      packageId: "provider-ollama-cloud",
      enabled: false,
    });
    // Switching the provider Package off does not stop the Bot answering: the
    // platform bootstrap stands in, and the choice that could not bind — with
    // the reason — rides along so the shell can say so.
    const degraded = resolveEffectiveBotModelV1({ bot, user, packages });
    expect(degraded).toMatchObject({
      source: "platform",
      binding: { state: "ready", packageId: "provider-flock-ai" },
      fallback: {
        from: "account",
        model: {
          connectionId: LEGACY_OLLAMA_CONNECTION_ID,
          providerModelId: LEGACY_OLLAMA_MODEL_ID,
        },
        failure: "Turn this model's plugin back on in Plugins to use it.",
      },
    });

    await execute({
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: "follow-platform-again",
      expectedRevision: user.revision,
      packageId: "custom-models",
      unset: ["account-model"],
    });
    expect(resolveEffectiveBotModelV1({ bot, user, packages })).toMatchObject({
      source: "platform",
      binding: { state: "ready", packageId: "provider-flock-ai" },
    });

    // Disabling the choice Package makes its retained value inert. Reapply it
    // first so this assertion distinguishes Package enablement from clearing.
    await execute({
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: "retain-ollama-choice",
      expectedRevision: user.revision,
      packageId: "custom-models",
      values: {
        "account-model": {
          connectionId: LEGACY_OLLAMA_CONNECTION_ID,
          providerModelId: LEGACY_OLLAMA_MODEL_ID,
        },
      },
    });
    await execute({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "disable-custom-models",
      expectedRevision: user.revision,
      packageId: "custom-models",
      enabled: false,
    });
    expect(resolveEffectiveBotModelV1({ bot, user, packages })).toMatchObject({
      source: "platform",
      binding: { state: "ready", packageId: "provider-flock-ai" },
    });
    expect(
      user.packages.find((pkg) => pkg.packageId === "custom-models")?.values,
    ).toEqual({
      "account-model": {
        connectionId: LEGACY_OLLAMA_CONNECTION_ID,
        providerModelId: LEGACY_OLLAMA_MODEL_ID,
      },
    });
  });

  test("repairs the owner's revision 38 production model state after its v2 marker", async () => {
    const userId = "production-model-user";
    const storage = new MemoryStorage();
    await storage.put({
      [PRODUCTION_SETTINGS_STATE_KEY]: productionUserSettingsRecordV1(),
      [PRODUCTION_DEFAULT_PACKAGES_MARKER_KEY]:
        productionDefaultPackagesMarkerV2(),
      [PRODUCTION_FLOCK_BOOTSTRAP_MARKER_KEY]:
        productionFlockBootstrapMarkerV1(userId),
      [PRODUCTION_CATALOG_PIN_KEY]: productionCatalogPinV1(),
    });
    const bound = identity(userId);
    const configuration = new UserConfiguration(bound.ctx(storage), {
      ...bound.env,
      CREDENTIAL_KEYRING: credentialKeyring,
    });

    const plan = await compileFoundationApplication();
    const packages = await executionPackages();
    let user = await configuration.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    const platformPackageIds = plan.packages
      .filter((pkg) =>
        isPlatformOwnedPackageV1(
          pkg.manifest,
          new Set(
            plan.packages
              .filter(
                (candidate) =>
                  candidate.manifest.defaultEnablement !== undefined ||
                  (candidate.manifest.configuration?.connectionTypes.length ??
                    0) > 0 ||
                  (candidate.manifest.configuration?.capabilities.length ?? 0) >
                    0,
              )
              .flatMap((candidate) => [
                candidate.id,
                ...Object.keys(candidate.manifest.dependencies),
              ]),
          ).has(pkg.id),
        ),
      )
      .map((pkg) => pkg.id);
    for (const packageId of platformPackageIds) {
      expect(user.packages).toContainEqual(
        expect.objectContaining({ packageId, state: "installed" }),
      );
    }
    for (const packageId of [
      "flock",
      "bot-template",
      "user-machine",
      "machine-messages",
      "mcp",
      "routines",
      "subagents",
    ]) {
      expect(user.packages).toContainEqual(
        expect.objectContaining({ packageId, state: "installed" }),
      );
    }
    for (const packageId of ["custom-models", "provider-ollama-cloud"]) {
      expect(user.packages).toContainEqual(
        expect.objectContaining({ packageId, state: "disabled" }),
      );
    }
    expect(user.platformModel).toEqual({
      connectionId: "flock-ai-ambient",
      providerModelId: "@flock/auto",
    });
    let effective = resolveEffectiveBotModelV1({
      bot: { packageValues: {} },
      user,
      packages,
    });
    expect(effective).toMatchObject({
      source: "platform",
      binding: { state: "ready", packageId: "provider-flock-ai" },
    });
    const execute = async (command: UserConfigurationCommandV1) => {
      const receipt = await configuration.executeConfiguration({
        schemaVersion: 1,
        userId,
        command,
      });
      expect(receipt).toMatchObject({ status: "applied" });
      user = await configuration.readConfiguration({
        schemaVersion: 1,
        userId,
      });
      return receipt;
    };
    await execute({
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-custom-models-from-production-state",
      expectedRevision: user.revision,
      packageId: "custom-models",
      version: "0.0.1",
    });
    await execute({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "enable-ollama-from-production-state",
      expectedRevision: user.revision,
      packageId: "provider-ollama-cloud",
      enabled: true,
    });
    await execute({
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: "choose-production-ollama-model",
      expectedRevision: user.revision,
      packageId: "custom-models",
      values: {
        "account-model": {
          connectionId: PRODUCTION_OLLAMA_CONNECTION_ID,
          providerModelId: PRODUCTION_OLLAMA_MODEL_ID,
        },
      },
    });
    expect(
      resolveEffectiveBotModelV1({
        bot: { packageValues: {} },
        user,
        packages,
      }),
    ).toMatchObject({
      source: "account",
      model: {
        connectionId: PRODUCTION_OLLAMA_CONNECTION_ID,
        providerModelId: PRODUCTION_OLLAMA_MODEL_ID,
      },
      binding: { state: "ready", packageId: "provider-ollama-cloud" },
    });

    await execute({
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: "clear-production-ollama-model",
      expectedRevision: user.revision,
      packageId: "custom-models",
      unset: ["account-model"],
    });
    effective = resolveEffectiveBotModelV1({
      bot: { packageValues: {} },
      user,
      packages,
    });
    expect(effective).toMatchObject({
      source: "platform",
      binding: { state: "ready", packageId: "provider-flock-ai" },
    });

    for (const packageId of ["shell", "provider-flock-ai"]) {
      const failure = `Platform-owned Package "${packageId}" cannot be disabled or uninstalled`;
      for (const command of [
        {
          schemaVersion: 1 as const,
          type: "user/set-package-enabled" as const,
          commandId: `disable-${packageId}`,
          expectedRevision: user.revision,
          packageId,
          enabled: false,
        },
        {
          schemaVersion: 1 as const,
          type: "user/uninstall-package" as const,
          commandId: `uninstall-${packageId}`,
          expectedRevision: user.revision,
          packageId,
        },
      ]) {
        await expect(
          configuration.executeConfiguration({
            schemaVersion: 1,
            userId,
            command,
          }),
        ).resolves.toEqual({
          schemaVersion: 1,
          commandId: command.commandId,
          revision: user.revision,
          status: "rejected",
          failure,
        });
      }
    }
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
