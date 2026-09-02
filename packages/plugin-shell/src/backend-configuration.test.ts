import { describe, expect, test } from "bun:test";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import type {
  BotConfigurationCommandV1,
  BotSettingsViewV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import { createShellBotBackendContribution } from "./backend.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ) as Array<[string, T]>,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

const MODEL_SETTING = {
  id: "model",
  schemaVersion: 1,
  scopes: ["user", "bot"],
  role: "model",
  schema: {
    type: "object",
    properties: {
      connectionId: { type: "string" },
      providerModelId: { type: "string" },
    },
    required: ["connectionId", "providerModelId"],
    additionalProperties: false,
  },
} as const satisfies PackageSettingDefinition;

const TONE_SETTING = {
  id: "tone",
  schemaVersion: 1,
  scopes: ["bot"],
  schema: { type: "string", maxLength: 40 },
} as const satisfies PackageSettingDefinition;

async function compileModelTestApplication(): ReturnType<
  typeof compileFoundationApplication
> {
  const application = await compileFoundationApplication();
  const provider = application.packages.find(
    (pkg) => pkg.id === "provider-flock-ai",
  );
  const template = application.packages.find((pkg) => pkg.id === "settings");
  if (!provider || !template) throw new Error("Fixture Packages unavailable");
  return {
    ...application,
    packages: [
      ...application.packages.filter(
        (pkg) => pkg.id !== provider.id && pkg.id !== "custom-models",
      ),
      provider,
      {
        ...template,
        id: "custom-models",
        specifier: "@test/custom-models",
        version: "0.0.1",
        manifest: {
          ...template.manifest,
          id: "custom-models",
          displayName: "Custom models",
          version: "0.0.1",
          dependencies: {},
          contributions: {},
          permissions: [],
          configuration: {
            settings: [MODEL_SETTING, TONE_SETTING],
            connectionTypes: [],
            capabilities: [],
          },
        },
      },
    ],
  };
}

function model(connectionId: string, providerModelId: string) {
  return { connectionId, providerModelId };
}

function configuredUser(): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    profile: { name: "User" },
    packages: [
      {
        packageId: "provider-flock-ai",
        version: "0.0.1",
        state: "installed",
      },
      {
        packageId: "custom-models",
        version: "0.0.1",
        state: "disabled",
      },
    ],
    connections: [
      {
        connectionId: "flock-ai-ambient",
        packageId: "provider-flock-ai",
        connectionTypeId: "flock-ai-account",
        displayName: "Flock AI",
        state: "ready",
        providerType: "flock-ai",
        generation: "foundation-generation-1",
        modelCatalog: {
          schemaVersion: 1,
          generation: "catalog-1",
          state: "fresh",
          models: [
            {
              providerModelId: "@flock/auto",
              displayName: "Platform",
              capabilities: {
                tools: true,
                vision: false,
                reasoning: false,
              },
              source: "discovered",
            },
          ],
        },
        safeMetadata: {},
      },
    ],
    platformModel: model("flock-ai-ambient", "@flock/auto"),
  };
}

function host(storage: MemoryStorage, readUser: () => UserSettingsViewV1) {
  return createShellBotBackendContribution({
    state: { storage } as unknown as DurableObjectState,
    env: {
      CREDENTIAL_KEYRING:
        '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}',
      USER_CONFIGURATIONS: {
        idFromName: () => "user-1",
        get: () => ({
          readConfiguration: () => Promise.resolve(structuredClone(readUser())),
          listBots: () =>
            Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
        }),
      },
      MEMORY_FILES: {},
      MEMORY_INDEX: {},
      FLOCK_AI: {
        autoRoute: "flock-auto",
        runChatCompletion: () =>
          Promise.resolve(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"Cordis runtime: hello"}}]}\n\n' +
                      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                      "data: [DONE]\n\n",
                  ),
                );
                controller.close();
              },
            }),
          ),
      },
    } as never,
    compileApplication: compileModelTestApplication,
  });
}

function request(command: BotConfigurationCommandV1) {
  return {
    schemaVersion: 1 as const,
    userId: "user-1",
    botId: command.botId,
    command,
  };
}

describe("Bot configuration admission", () => {
  test("rejects an unmaterialized Bot without writing durable state", async () => {
    const storage = new MemoryStorage();
    const contribution = host(storage, configuredUser);

    await expect(
      contribution.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "unknown",
      }),
    ).rejects.toThrow("not materialized");
    expect(storage.values.size).toBe(0);
  });

  test("rejects archived settings mutations while preserving configuration reads", async () => {
    const storage = new MemoryStorage();
    let archived = false;
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
      assertLifecycleActive: (_transaction, botId) => {
        if (archived)
          return Promise.reject(new Error(`Bot "${botId}" is archived`));
        return Promise.resolve();
      },
    });
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });
    archived = true;

    await expect(
      contribution.executeConfiguration(
        request({
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "archived-profile",
          botId: identity.botId,
          expectedRevision: 0,
          profile: { name: "Changed" },
        }),
      ),
    ).rejects.toThrow("archived");
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 0,
      profile: { name: "Primary" },
    });
  });

  test("rechecks lifecycle admission in the mutation transaction", async () => {
    const storage = new MemoryStorage();
    let admissions = 0;
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
      assertLifecycleActive: (_transaction, botId) => {
        admissions += 1;
        return admissions === 1
          ? Promise.resolve()
          : Promise.reject(new Error(`Bot "${botId}" is archived`));
      },
    });
    await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Primary" },
    );

    await expect(
      contribution.executeConfiguration(
        request({
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "racing-profile",
          botId: "primary",
          expectedRevision: 0,
          profile: { name: "Changed" },
        }),
      ),
    ).rejects.toThrow("archived");
    expect(
      await contribution.getSettings({ userId: "user-1", botId: "primary" }),
    ).toMatchObject({
      revision: 0,
      profile: { name: "Primary" },
    });
  });

  test("validates notification authority without changing settings", async () => {
    const storage = new MemoryStorage();
    const settings = {
      schemaVersion: 1,
      botId: "primary",
      revision: 7,
      profile: { name: "Primary" },
      notifications: { enabled: true },
      packageValues: {},
    } satisfies BotSettingsViewV1;
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "bot-configuration": settings,
    });
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });

    await expect(
      contribution.validateIdentity({ userId: "user-1", botId: "primary" }),
    ).resolves.toBeUndefined();
    await expect(
      contribution.validateIdentity({ userId: "other", botId: "primary" }),
    ).rejects.toThrow("Bot authority does not match its durable identity");
    await expect(
      contribution.getSettings({ userId: "other", botId: "primary" }),
    ).rejects.toThrow("Bot authority does not match its durable identity");
    expect(await storage.get<BotSettingsViewV1>("bot-configuration")).toEqual(
      settings,
    );
  });

  test("initializes current Bot settings without historical-state branching", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      identity: { userId: "user-1", botId: "primary" },
      "latest-events": [{ type: "user", text: "existing history" }],
      "active-run": "run-1",
      "run:run-1": { status: "completed" },
    });
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    const identity = { userId: "user-1", botId: "primary" };

    await contribution.materializeSettings(identity, { name: "Primary" });
    await expect(contribution.getSettings(identity)).resolves.toMatchObject({
      revision: 0,
      profile: { name: "Primary" },
      packageValues: {},
    });
  });

  test("binds in-flight and durable receipts to the complete Bot command", async () => {
    const storage = new MemoryStorage();
    const backendHost = {
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    };
    const original: BotConfigurationCommandV1 = {
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "profile-command",
      botId: "primary",
      expectedRevision: 0,
      profile: { name: "Original" },
    };
    const collision: BotConfigurationCommandV1 = {
      ...original,
      profile: { name: "Collision" },
    };
    const contribution = createShellBotBackendContribution(backendHost);
    await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Primary" },
    );

    const first = contribution.executeConfiguration(request(original));
    await expect(
      contribution.executeConfiguration(request(collision)),
    ).rejects.toThrow(
      'Configuration command idempotency key "profile-command" was reused for a different command',
    );
    const receipt = await first;

    const redeployed = createShellBotBackendContribution(backendHost);
    await expect(
      redeployed.executeConfiguration(request(original)),
    ).resolves.toEqual(receipt);
    await expect(
      redeployed.executeConfiguration(request(collision)),
    ).rejects.toThrow(
      'Configuration command idempotency key "profile-command" was reused for a different command',
    );
    await expect(
      redeployed.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "primary",
      }),
    ).resolves.toMatchObject({
      revision: 1,
      profile: { name: "Original" },
    });
  });
});

describe("generic per-Turn model resolution", () => {
  test("runs on the platform model without creating a per-Bot model record", async () => {
    const storage = new MemoryStorage();
    const contribution = host(storage, configuredUser);
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });

    const result = await contribution.run({
      ...identity,
      runId: "platform-model-run",
      sessionId: "user-1:primary",
      acceptedAt: "2026-09-02T00:00:00.000Z",
      text: "hello",
    });

    expect(result.text).toBe("Cordis runtime: hello");
    const settings = await contribution.getSettings(identity);
    expect(settings).toMatchObject({ revision: 0, packageValues: {} });
    expect(Object.hasOwn(settings, "model")).toBe(false);
  });

  test("uses an enabled Bot-scoped model value and preserves it while disabled", async () => {
    const storage = new MemoryStorage();
    let user = configuredUser();
    user.packages[1] = {
      ...user.packages[1]!,
      state: "installed",
      values: { model: model("flock-ai-ambient", "account-model") },
    };
    const contribution = host(storage, () => user);
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });
    await contribution.executeConfiguration(
      request({
        schemaVersion: 1,
        type: "bot/set-package-settings",
        commandId: "set-bot-model",
        botId: "primary",
        expectedRevision: 0,
        packageId: "custom-models",
        values: { model: model("flock-ai-ambient", "bot-model") },
      }),
    );

    expect(await contribution.resolveConfiguration(identity)).toMatchObject({
      model: model("flock-ai-ambient", "bot-model"),
    });

    user = {
      ...user,
      packages: user.packages.map((pkg) =>
        pkg.packageId === "custom-models"
          ? { ...pkg, state: "disabled" as const }
          : pkg,
      ),
    };
    expect(await contribution.resolveConfiguration(identity)).toMatchObject({
      model: model("flock-ai-ambient", "@flock/auto"),
    });
    expect(await contribution.getSettings(identity)).toMatchObject({
      packageValues: {
        "custom-models": {
          model: model("flock-ai-ambient", "bot-model"),
        },
      },
    });

    user = {
      ...user,
      packages: user.packages.map((pkg) =>
        pkg.packageId === "custom-models"
          ? { ...pkg, state: "installed" as const }
          : pkg,
      ),
    };
    expect(await contribution.resolveConfiguration(identity)).toMatchObject({
      model: model("flock-ai-ambient", "bot-model"),
    });
  });

  test("Package disablement and Connection revocation fail every Bot's next Turn closed", async () => {
    let user = configuredUser();
    const bots = ["alpha", "beta"].map((botId) => {
      const storage = new MemoryStorage();
      return {
        botId,
        storage,
        contribution: host(storage, () => user),
      };
    });
    for (const bot of bots) {
      await bot.contribution.materializeSettings(
        { userId: "user-1", botId: bot.botId },
        { name: bot.botId },
      );
    }

    user = {
      ...user,
      packages: user.packages.map((pkg) =>
        pkg.packageId === "provider-flock-ai"
          ? { ...pkg, state: "disabled" as const }
          : pkg,
      ),
    };
    for (const bot of bots) {
      const runId = `${bot.botId}-disabled-package`;
      await expect(
        bot.contribution.run({
          userId: "user-1",
          botId: bot.botId,
          runId,
          sessionId: `user-1:${bot.botId}`,
          acceptedAt: "2026-09-02T00:01:00.000Z",
          text: "must fail",
        }),
      ).rejects.toThrow("not installed and enabled");
      expect(await bot.storage.get(`run:${runId}`)).toMatchObject({
        status: "failed",
        failure: expect.stringContaining("not installed and enabled"),
      });
    }

    user = configuredUser();
    user.connections[0] = { ...user.connections[0]!, state: "revoked" };
    for (const bot of bots) {
      const runId = `${bot.botId}-revoked-connection`;
      await expect(
        bot.contribution.run({
          userId: "user-1",
          botId: bot.botId,
          runId,
          sessionId: `user-1:${bot.botId}`,
          acceptedAt: "2026-09-02T00:02:00.000Z",
          text: "must fail",
        }),
      ).rejects.toThrow("is revoked");
      expect(await bot.storage.get(`run:${runId}`)).toMatchObject({
        status: "failed",
        failure: expect.stringContaining("is revoked"),
      });
    }
  });
});

describe("Bot Package setting commands", () => {
  test("validates, revision-fences, merges, and replays durably", async () => {
    const storage = new MemoryStorage();
    const user = configuredUser();
    const contribution = host(storage, () => user);
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });

    await expect(
      contribution.executeConfiguration(
        request({
          schemaVersion: 1,
          type: "bot/set-package-settings",
          commandId: "invalid-model",
          botId: "primary",
          expectedRevision: 0,
          packageId: "custom-models",
          values: { model: { connectionId: "flock-ai-ambient" } as never },
        }),
      ),
    ).rejects.toThrow("model has invalid fields");
    expect((await contribution.getSettings(identity)).revision).toBe(0);

    const first: BotConfigurationCommandV1 = {
      schemaVersion: 1,
      type: "bot/set-package-settings",
      commandId: "set-package-values",
      botId: "primary",
      expectedRevision: 0,
      packageId: "custom-models",
      values: {
        model: model("flock-ai-ambient", "bot-model"),
        tone: "concise",
      },
    };
    const receipt = await contribution.executeConfiguration(request(first));
    await expect(
      contribution.executeConfiguration(request(first)),
    ).resolves.toEqual(receipt);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 1,
      packageValues: {
        "custom-models": {
          model: model("flock-ai-ambient", "bot-model"),
          tone: "concise",
        },
      },
    });

    await contribution.executeConfiguration(
      request({
        ...first,
        commandId: "update-model-only",
        expectedRevision: 1,
        values: { model: model("flock-ai-ambient", "new-bot-model") },
      }),
    );
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 2,
      packageValues: {
        "custom-models": {
          model: model("flock-ai-ambient", "new-bot-model"),
          tone: "concise",
        },
      },
    });

    await contribution.executeConfiguration(
      request({
        ...first,
        commandId: "unset-bot-model",
        expectedRevision: 2,
        values: undefined,
        unset: ["model"],
      }),
    );
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 3,
      packageValues: { "custom-models": { tone: "concise" } },
    });

    await expect(
      contribution.executeConfiguration(
        request({
          ...first,
          commandId: "unset-unknown",
          expectedRevision: 3,
          values: undefined,
          unset: ["unknown-setting"],
        }),
      ),
    ).rejects.toThrow(/not declared by this Package/);

    await expect(
      contribution.executeConfiguration(
        request({
          ...first,
          commandId: "stale-revision",
          expectedRevision: 2,
        }),
      ),
    ).rejects.toThrow("configuration revision is 3");
    await expect(
      contribution.executeConfiguration(
        request({
          ...first,
          values: { tone: "different" },
        }),
      ),
    ).rejects.toThrow("reused for a different command");
  });
});
