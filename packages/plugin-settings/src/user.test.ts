import { describe, expect, test } from "bun:test";
import type { CatalogEntryV1, CatalogIndexV1 } from "@frockbot/catalog-core";
import {
  USER_PROFILE_PLACEHOLDER_NAME_V1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createUserSettingsBackendContribution,
  type AvailableUserPackage,
  type UserPackageCatalogHost,
  type UserSettingsStorage,
} from "./user.js";

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();
  failAfterWrite?: string;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
        if (this.failAfterWrite === entry) {
          this.failAfterWrite = undefined;
          return Promise.reject(new Error("injected atomic write failure"));
        }
      }
    }
    return Promise.resolve();
  }

  async transaction<T>(
    callback: (storage: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }
}

function contribution(storage = new MemoryStorage()) {
  return createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "flock", version: "0.0.1" },
      { packageId: "settings", version: "0.0.1" },
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        settings: [
          {
            id: "web-search-max-results",
            schemaVersion: 1,
            scopes: ["user"],
            schema: { type: "integer", minimum: 1, maximum: 10 },
          },
          {
            id: "label",
            schemaVersion: 1,
            scopes: ["user"],
            schema: { type: "string", maxLength: 16 },
          },
        ],
      },
    ],
  });
}

/** Install the Ollama Package, so a settings command has a row to write to. */
async function installOllama(
  settings: ReturnType<typeof contribution>,
  userId: string,
): Promise<void> {
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-${userId}`,
      expectedRevision: 0,
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
    },
  });
}

describe("User settings backend Contribution", () => {
  test("reads old settings purely and writes the migrated shape on the next command", async () => {
    const storage = new MemoryStorage();
    // Literal durable shape from eb0283edcce5daea976a21a9f6a6414bedc6e2bc,
    // the first parent of PR #134's merge commit.
    const historical = {
      schemaVersion: 1,
      revision: 7,
      profile: { name: "Existing User" },
      packages: [],
      connections: [
        {
          connectionId: "ollama-1",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          safeMetadata: {
            dependentAssignments: [
              {
                botId: "primary",
                generation: "assignment-1",
                packageId: "provider-ollama-cloud",
                capabilityId: "ollama-cloud-models",
                claimOrder: 0,
                status: "acknowledged",
              },
            ],
          },
        },
      ],
      newBotModelTemplate: {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
      },
      newBotModelTemplateSource: "user",
    };
    storage.values.set("user-configuration", structuredClone(historical));
    const settings = contribution(storage);

    await expect(settings.readSnapshot()).resolves.toMatchObject({
      revision: 7,
      connections: [{ safeMetadata: {} }],
    });
    expect(await storage.get<unknown>("user-configuration")).toEqual(
      historical,
    );

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "migrate-user-settings",
        expectedRevision: 7,
        profile: { name: "Migrated User" },
      },
    });
    const written =
      await storage.get<Record<string, unknown>>("user-configuration");
    expect(written).toMatchObject({
      revision: 8,
      profile: { name: "Migrated User" },
      connections: [{ safeMetadata: {} }],
    });
    expect(written).not.toHaveProperty("newBotModelTemplate");
    expect(written).not.toHaveProperty("newBotModelTemplateSource");
  });

  test("bootstraps first-party Packages once and preserves a later uninstall", async () => {
    const storage = new MemoryStorage();
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages: [
        {
          packageId: "web",
          version: "0.0.1",
          installByDefault: true,
        },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          installByDefault: true,
        },
        { packageId: "settings", version: "0.0.1" },
      ],
    });

    const first = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(first).toMatchObject({
      revision: 1,
      packages: [
        {
          packageId: "web",
          version: "0.0.1",
          state: "installed",
          provenance: "first-party",
        },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
          provenance: "first-party",
        },
      ],
    });
    expect(
      await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).toEqual(first);

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: "uninstall-web",
        expectedRevision: 1,
        packageId: "web",
      },
    });
    const afterUninstall = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(afterUninstall.revision).toBe(2);
    expect(afterUninstall.packages.map((pkg) => pkg.packageId)).toEqual([
      "provider-ollama-cloud",
    ]);
  });

  test("bootstraps a declared default-disabled Package without re-enabling it", async () => {
    const settings = createUserSettingsBackendContribution({
      storage: new MemoryStorage(),
      availablePackages: [
        {
          packageId: "custom-models",
          version: "0.0.1",
          installByDefault: true,
          defaultEnablement: "disabled",
        },
      ],
    });

    const first = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(first.packages).toEqual([
      {
        packageId: "custom-models",
        version: "0.0.1",
        state: "disabled",
        provenance: "first-party",
      },
    ]);
    expect(
      await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).toEqual(first);
  });

  test("repairs a pre-default-enablement account before Package enablement", async () => {
    const storage = new MemoryStorage();
    const availablePackages: AvailableUserPackage[] = [
      {
        packageId: "custom-models",
        version: "0.0.1",
        installByDefault: true,
        defaultEnablement: "disabled",
        dependencies: {
          settings: ">=0.0.1",
          shell: ">=0.0.1",
          "ui-theme": ">=0.0.1",
        },
      },
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        installByDefault: true,
        defaultEnablement: "disabled",
        dependencies: {
          "custom-models": ">=0.0.1",
          credentials: ">=0.0.1",
          settings: ">=0.0.1",
          web: ">=0.0.1",
        },
      },
      { packageId: "credentials", version: "0.0.1", installByDefault: true },
      { packageId: "settings", version: "0.0.1", installByDefault: true },
      { packageId: "shell", version: "0.0.1", installByDefault: true },
      { packageId: "ui-theme", version: "0.0.1", installByDefault: true },
      { packageId: "web", version: "0.0.1", installByDefault: true },
    ];
    await storage.put("user-id", "legacy-user");
    await storage.put("user-default-packages-bootstrap:v1", {
      schemaVersion: 1,
    });
    await storage.put("user-configuration", {
      schemaVersion: 1,
      revision: 12,
      profile: { name: "Legacy User" },
      packages: [
        {
          packageId: "provider-workers-ai",
          version: "0.0.1",
          state: "installed",
        },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "workers-ai-ambient",
          packageId: "provider-workers-ai",
          connectionTypeId: "workers-ai-account",
          displayName: "Cloudflare Workers AI",
          state: "ready",
          generation: "workers-ai-ambient-v1",
          providerType: "workers-ai",
          safeMetadata: { catalog: "static" },
        },
        {
          connectionId: "ollama-legacy",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Ollama",
          state: "ready",
          generation: "ollama-generation-1",
          providerType: "ollama-cloud",
          safeMetadata: {
            dependentAssignments: [
              {
                botId: "primary",
                generation: "assignment-1",
                packageId: "provider-ollama-cloud",
                capabilityId: "ollama-cloud-models",
                claimOrder: 1,
                status: "acknowledged",
              },
            ],
          },
        },
      ],
      platformModel: {
        connectionId: "workers-ai-ambient",
        providerModelId: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      },
      newBotModelTemplate: {
        connectionId: "ollama-legacy",
        providerModelId: "glm-5.3-flash:cloud",
      },
      newBotModelTemplateSource: "user",
    });
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages,
    });

    const migrated = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "legacy-user",
    });
    expect(migrated.packages).toEqual([
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "disabled",
      },
      {
        packageId: "custom-models",
        version: "0.0.1",
        state: "disabled",
        provenance: "first-party",
      },
      ...availablePackages.slice(2).map(({ packageId, version }) => ({
        packageId,
        version,
        state: "installed" as const,
        provenance: "first-party" as const,
      })),
    ]);
    expect(migrated.connections).toEqual([
      expect.objectContaining({
        connectionId: "ollama-legacy",
        safeMetadata: {},
      }),
    ]);
    expect(migrated.platformModel).toBeUndefined();

    const customModels = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "legacy-user",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "enable-custom-models-after-migration",
        expectedRevision: migrated.revision,
        packageId: "custom-models",
        enabled: true,
      },
    });
    expect(customModels).toMatchObject({ status: "applied" });
    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "legacy-user",
        command: {
          schemaVersion: 1,
          type: "user/set-package-enabled",
          commandId: "enable-ollama-after-migration",
          expectedRevision: customModels.revision,
          packageId: "provider-ollama-cloud",
          enabled: true,
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
  });

  test("seeds rollout dependencies before validating a pre-existing enablement graph", async () => {
    const storage = new MemoryStorage();
    const availablePackages: AvailableUserPackage[] = [
      {
        packageId: "custom-models",
        version: "0.0.1",
        installByDefault: true,
        defaultEnablement: "disabled",
        dependencies: {
          settings: ">=0.0.1",
          shell: ">=0.0.1",
          "ui-theme": ">=0.0.1",
        },
      },
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        installByDefault: true,
        defaultEnablement: "disabled",
        dependencies: {
          "custom-models": ">=0.0.1",
          credentials: ">=0.0.1",
          settings: ">=0.0.1",
        },
      },
      { packageId: "credentials", version: "0.0.1", installByDefault: true },
      {
        packageId: "settings",
        version: "0.0.1",
        installByDefault: true,
        dependencies: { shell: ">=0.0.1", "ui-theme": ">=0.0.1" },
      },
      {
        packageId: "shell",
        version: "0.0.1",
        installByDefault: true,
        dependencies: { "ui-theme": ">=0.0.1" },
      },
      { packageId: "ui-theme", version: "0.0.1", installByDefault: true },
      {
        packageId: "mcp",
        version: "0.0.1",
        installByDefault: true,
        dependencies: {
          credentials: ">=0.0.1",
          settings: ">=0.0.1",
        },
      },
    ];
    await storage.put("user-id", "pre-rollout-user");
    await storage.put("user-default-packages-bootstrap:v1", {
      schemaVersion: 1,
    });
    await storage.put("user-configuration", {
      schemaVersion: 1,
      revision: 12,
      profile: { name: "Pre-rollout User" },
      packages: [
        {
          packageId: "shell",
          version: "0.0.1",
          state: "installed",
          provenance: "first-party",
        },
        {
          packageId: "mcp",
          version: "0.0.1",
          state: "installed",
          provenance: "first-party",
        },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
          provenance: "first-party",
        },
      ],
      connections: [],
    });
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages,
    });

    const migrated = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "pre-rollout-user",
    });

    expect(migrated.packages).toContainEqual(
      expect.objectContaining({ packageId: "shell", state: "installed" }),
    );
    expect(migrated.packages).toContainEqual(
      expect.objectContaining({ packageId: "mcp", state: "installed" }),
    );
    expect(migrated.packages).toContainEqual(
      expect.objectContaining({
        packageId: "custom-models",
        state: "disabled",
      }),
    );
    expect(migrated.packages).toContainEqual(
      expect.objectContaining({
        packageId: "provider-ollama-cloud",
        state: "disabled",
      }),
    );
  });

  test("repairs v2 rollout damage once and preserves choices made after v3", async () => {
    const storage = new MemoryStorage();
    await storage.put("user-id", "damaged-user");
    await storage.put("user-default-packages-bootstrap:v1", {
      schemaVersion: 2,
    });
    await storage.put("user-configuration", {
      schemaVersion: 1,
      revision: 38,
      profile: { name: "Damaged User" },
      packages: [
        {
          packageId: "web",
          version: "0.0.1",
          state: "disabled",
          provenance: "first-party",
        },
      ],
      connections: [],
    });
    const settings = createUserSettingsBackendContribution({
      storage,
      availablePackages: [
        { packageId: "web", version: "0.0.1", installByDefault: true },
      ],
    });

    const repaired = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "damaged-user",
    });
    expect(repaired).toMatchObject({
      revision: 39,
      packages: [{ packageId: "web", state: "installed" }],
    });
    expect(
      await storage.get<{ schemaVersion: number }>(
        "user-default-packages-bootstrap:v1",
      ),
    ).toEqual({
      schemaVersion: 3,
    });

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "damaged-user",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-web-after-v3",
        expectedRevision: 39,
        packageId: "web",
        enabled: false,
      },
    });
    const chosen = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "damaged-user",
    });
    expect(chosen).toMatchObject({
      revision: 40,
      packages: [{ packageId: "web", state: "disabled" }],
    });
  });

  test("installs a Package disabled when explicitly requested", async () => {
    const settings = contribution();
    const receipt = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-disabled",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        enabled: false,
      },
    });

    expect(receipt).toMatchObject({ status: "applied", revision: 1 });
    expect((await settings.read("user-1")).packages).toMatchObject([
      { packageId: "provider-ollama-cloud", state: "disabled" },
    ]);
  });

  test("does not clear an existing failed installation", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);
    await storage.put("user-id", "user-1");
    await storage.put("user-configuration", {
      schemaVersion: 1,
      revision: 0,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "failed",
          failure: "activation failed",
        },
      ],
      connections: [],
    } satisfies UserSettingsViewV1);

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "retry-failed-disabled",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        enabled: false,
      },
    });

    expect((await settings.read("user-1")).packages).toMatchObject([
      {
        packageId: "provider-ollama-cloud",
        state: "failed",
        failure: "activation failed",
      },
    ]);
  });

  test("refuses enabling until every declared dependency is enabled", async () => {
    const settings = createUserSettingsBackendContribution({
      storage: new MemoryStorage(),
      availablePackages: [
        { packageId: "custom-models", version: "0.0.1" },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          dependencies: { "custom-models": ">=0.0.1" },
        },
      ],
    });
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-custom-models-disabled",
        expectedRevision: 0,
        packageId: "custom-models",
        version: "0.0.1",
        enabled: false,
      },
    });
    const refusedInstall = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-ollama-enabled-too-soon",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    expect(refusedInstall).toMatchObject({
      status: "rejected",
      revision: 1,
      failure: expect.stringContaining("custom-models"),
    });
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-ollama-disabled",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        enabled: false,
      },
    });

    const refused = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "enable-ollama-too-soon",
        expectedRevision: 2,
        packageId: "provider-ollama-cloud",
        enabled: true,
      },
    });
    expect(refused).toMatchObject({
      status: "rejected",
      revision: 2,
      failure: expect.stringContaining("custom-models"),
    });
    expect((await settings.read("user-1")).packages[1]?.state).toBe("disabled");

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "enable-custom-models",
        expectedRevision: 2,
        packageId: "custom-models",
        enabled: true,
      },
    });
    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-enabled",
          commandId: "enable-ollama",
          expectedRevision: 3,
          packageId: "provider-ollama-cloud",
          enabled: true,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 4 });

    // The mirror of the rule above, read the other way round. Disabling the
    // dependency is allowed — refusing it would make a Package the User never
    // chose able to pin one they did — and carries its dependents with it, so
    // the account never lands in the state the enable path refuses:
    // `custom-models=disabled provider-ollama-cloud=installed`.
    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-enabled",
          commandId: "disable-custom-models",
          expectedRevision: 4,
          packageId: "custom-models",
          enabled: false,
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 5 });
    const cascaded = await settings.read("user-1");
    expect(cascaded.packages[0]).toMatchObject({
      packageId: "custom-models",
      state: "disabled",
    });
    expect(cascaded.packages[1]).toMatchObject({
      packageId: "provider-ollama-cloud",
      state: "disabled",
    });

    // The cascade is not automatic re-enablement: turning the dependency back
    // on leaves the dependent off until the User asks for it.
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "re-enable-custom-models",
        expectedRevision: 5,
        packageId: "custom-models",
        enabled: true,
      },
    });
    expect((await settings.read("user-1")).packages[1]?.state).toBe("disabled");
  });

  test("applies the platform model through the backend Contribution", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);

    await settings.executeConfigurationCommand(
      "user-1",
      {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "bootstrap-platform-package",
        expectedRevision: 0,
        packageId: "flock",
        version: "0.0.1",
      },
      storage,
    );
    await settings.createConnection(
      "user-1",
      {
        connectionId: "flock-default",
        packageId: "flock",
        connectionTypeId: "flock-account",
        displayName: "Flock",
        state: "ready",
        providerType: "flock",
        safeMetadata: {},
      },
      storage,
    );

    await expect(
      settings.executeConfigurationCommand(
        "user-1",
        {
          schemaVersion: 1,
          type: "user/set-platform-model",
          commandId: "bootstrap-platform-model",
          expectedRevision: 2,
          model: {
            connectionId: "flock-default",
            providerModelId: "@frock/auto",
          },
        },
        storage,
      ),
    ).resolves.toMatchObject({ status: "applied", revision: 3 });
    expect((await settings.read("user-1")).platformModel).toEqual({
      connectionId: "flock-default",
      providerModelId: "@frock/auto",
    });
  });

  test("owns durable User configuration independently of providers", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);

    expect(
      await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).toEqual({
      schemaVersion: 1,
      revision: 0,
      profile: { name: USER_PROFILE_PLACEHOLDER_NAME_V1 },
      packages: [],
      connections: [],
    });

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "rename-user",
        expectedRevision: 0,
        profile: { name: "Tim" },
      },
    });

    expect(
      await storage.get<UserSettingsViewV1>("user-configuration"),
    ).toMatchObject({ revision: 1, profile: { name: "Tim" } });
  });

  test("admits only Packages declared by the immutable application", async () => {
    const settings = contribution();
    const install = {
      schemaVersion: 1 as const,
      userId: "user-1",
      command: {
        schemaVersion: 1 as const,
        type: "user/install-package" as const,
        commandId: "install-flock",
        expectedRevision: 0,
        packageId: "flock",
        version: "0.0.1",
      },
    };

    await expect(settings.executeConfiguration(install)).resolves.toMatchObject(
      {
        status: "applied",
        revision: 1,
      },
    );
    await expect(settings.executeConfiguration(install)).resolves.toMatchObject(
      {
        status: "applied",
        revision: 1,
      },
    );
    expect(await settings.isPackageInstalled("user-1", "flock")).toBe(true);

    await expect(
      settings.executeConfiguration({
        ...install,
        command: {
          ...install.command,
          commandId: "install-composio",
          expectedRevision: 1,
          packageId: "composio",
        },
      }),
    ).rejects.toThrow("Package is not available in this application");
  });

  test("compacts revoked Connections and bounds active Connections", async () => {
    const settings = contribution();
    await settings.read("user-1");
    const connection = (connectionId: string, state: "ready" | "revoked") =>
      ({
        connectionId,
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: connectionId,
        state,
        providerType: "ollama-cloud",
        generation: `generation-${connectionId}`,
        safeMetadata: {},
      }) as const;
    await settings.createConnection(
      "user-1",
      connection("revoked-1", "revoked"),
    );
    await settings.createConnection("user-1", connection("ready-0", "ready"));
    expect((await settings.read("user-1")).connections).toHaveLength(1);

    for (let index = 1; index < 100; index += 1) {
      await settings.createConnection(
        "user-1",
        connection(`ready-${index}`, "ready"),
      );
    }
    await expect(
      settings.createConnection(
        "user-1",
        connection("ready-over-limit", "ready"),
      ),
    ).rejects.toThrow("User Connection limit reached");
  });

  test("adjudicates Connection command authority without naming a provider", async () => {
    const settings = contribution();
    await settings.read("user-1");
    await settings.createConnection("user-1", {
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready",
      providerType: "ollama-cloud",
      generation: "generation-1",
      safeMetadata: {},
    });
    const owner = (packageId: string, retained: readonly string[]) => ({
      packageId,
      lookupConnectionCommand: (_accountId: string, commandId: string) =>
        Promise.resolve(retained.includes(commandId) ? {} : undefined),
    });
    const release = settings.registerConnectionCommandOwner(
      owner("provider-ollama-cloud", ["retained-1"]),
    );

    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "create-1",
        packageId: "provider-other",
        connectionTypeId: "other-account",
        label: "Other",
        apiKey: "secret",
      }),
    ).resolves.toBe("provider-other");
    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-1",
        connectionId: "connection-1",
      }),
    ).resolves.toBe("provider-ollama-cloud");
    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "retained-1",
        connectionId: "connection-compacted",
        revokeUpstream: false,
      }),
    ).resolves.toBe("provider-ollama-cloud");
    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "unknown-1",
        connectionId: "connection-compacted",
        revokeUpstream: false,
      }),
    ).rejects.toThrow("Connection is unavailable");

    const releaseSecond = settings.registerConnectionCommandOwner(
      owner("provider-other", ["retained-1"]),
    );
    expect(() =>
      settings.registerConnectionCommandOwner(
        owner("provider-other", ["retained-1"]),
      ),
    ).toThrow('Connection Package "provider-other" is already registered');
    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "retained-1",
        connectionId: "connection-compacted",
        revokeUpstream: false,
      }),
    ).rejects.toThrow("Connection command authority is ambiguous");

    releaseSecond();
    release();
    await expect(
      settings.resolveConnectionCommandOwner("user-1", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "retained-1",
        connectionId: "connection-compacted",
        revokeUpstream: false,
      }),
    ).rejects.toThrow("Connection is unavailable");
  });

  test("binds one durable state object to one User authority", async () => {
    const settings = contribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.readConfiguration({ schemaVersion: 1, userId: "user-2" }),
    ).rejects.toThrow("User authority does not match durable identity");
  });

  test("rejects corrupt durable settings and receipts at the storage seam", async () => {
    const corruptSettings = new MemoryStorage();
    await corruptSettings.put("user-configuration", { schemaVersion: 1 });
    await expect(
      contribution(corruptSettings).readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
      }),
    ).rejects.toThrow();

    const corruptReceipt = new MemoryStorage();
    await corruptReceipt.put("configuration-receipt:rename-user", {
      commandFingerprint: "invalid",
      receipt: { status: "applied" },
    });
    await expect(
      contribution(corruptReceipt).executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "rename-user",
          expectedRevision: 0,
          profile: { name: "Tim" },
        },
      }),
    ).rejects.toThrow();
  });
});

const CATALOG_HASH = "c".repeat(64);
const CATALOG_MANIFEST_HASH = "d".repeat(64);

function catalogEntry(overrides: Partial<CatalogEntryV1> = {}): CatalogEntryV1 {
  return {
    schemaVersion: 1,
    catalogId: "clock",
    packageId: "clock",
    displayName: "Clock",
    description: "Tells the time.",
    version: "0.0.1",
    kind: "package",
    manifestHash: CATALOG_MANIFEST_HASH,
    servers: [],
    setupFields: [],
    skills: [],
    ...overrides,
  };
}

/**
 * A Catalog whose pointer the test can move, so an install can be aimed at a
 * generation the User is no longer pinned to.
 */
class FakeCatalog implements UserPackageCatalogHost {
  generation = "gen-one";
  indexHash = CATALOG_HASH;
  entries: CatalogEntryV1[] = [catalogEntry()];
  reads = 0;

  readCurrentIndex(): Promise<{
    pin: { generation: string; indexHash: string };
    index: CatalogIndexV1;
  }> {
    this.reads += 1;
    return Promise.resolve({
      pin: { generation: this.generation, indexHash: this.indexHash },
      index: {
        schemaVersion: 1,
        generation: this.generation,
        entries: this.entries.map((entry) => ({
          catalogId: entry.catalogId,
          packageId: entry.packageId,
          displayName: entry.displayName,
          description: entry.description,
          version: entry.version,
          manifestHash: entry.manifestHash,
          kind: entry.kind,
          ...(entry.bundle === undefined
            ? {}
            : { contentHash: entry.bundle.contentHash }),
        })),
      },
    });
  }

  readEntry(
    generation: string,
    catalogId: string,
  ): Promise<CatalogEntryV1 | undefined> {
    if (generation !== this.generation) return Promise.resolve(undefined);
    return Promise.resolve(
      this.entries.find((entry) => entry.catalogId === catalogId),
    );
  }
}

function catalogContribution(
  storage = new MemoryStorage(),
  catalog = new FakeCatalog(),
) {
  return {
    storage,
    catalog,
    settings: createUserSettingsBackendContribution({
      storage,
      availablePackages: [{ packageId: "settings", version: "0.0.1" }],
      catalog,
    }),
  };
}

describe("remote Package Catalog", () => {
  test("pins a generation on the first read and holds it across reads", async () => {
    const { catalog, settings, storage } = catalogContribution();

    const first = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(first.catalogGeneration).toBe("gen-one");
    expect(first.catalogIndexHash).toBe(CATALOG_HASH);
    // Pinning is not a settings change: a client's `expectedRevision` survives.
    expect(first.revision).toBe(0);
    expect(
      (await storage.get<UserSettingsViewV1>("user-configuration")) ?? "absent",
    ).toBe("absent");

    catalog.generation = "gen-two";
    const second = await settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    expect(second.catalogGeneration).toBe("gen-one");
    expect(catalog.reads).toBe(1);
  });

  test("admits a Catalog install against the pinned generation", async () => {
    const { settings, storage } = catalogContribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-clock",
          expectedRevision: 0,
          packageId: "clock",
          version: "0.0.1",
          catalogId: "clock",
          catalogGeneration: "gen-one",
          values: { region: "au" },
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });

    expect(
      await storage.get<UserSettingsViewV1>("user-configuration"),
    ).toMatchObject({
      packages: [
        {
          packageId: "clock",
          version: "0.0.1",
          state: "installed",
          catalogId: "clock",
          catalogGeneration: "gen-one",
          provenance: "catalog",
          values: { region: "au" },
        },
      ],
    });
  });

  test("admits only the exact hash of a code-carrying Catalog entry", async () => {
    const contentHash = "b".repeat(64);
    const catalog = new FakeCatalog();
    catalog.entries = [
      catalogEntry({
        packageId: "parcel-tracking",
        catalogId: "parcel-tracking",
        displayName: "Parcel tracking",
        manifestHash: "e".repeat(64),
        bundle: {
          contentHash,
          size: 512,
          mediaType: "application/javascript",
          bundlerVersion: "catalog-test@1",
          manifest: {
            schemaVersion: 3,
            id: "parcel-tracking",
            displayName: "Parcel tracking",
            version: "0.0.1",
            compatibility: { frockbot: "*" },
            dependencies: {},
            contributions: {
              runtime: { entry: "./package.js", host: "bot-isolate" },
            },
            tools: [],
            permissions: [],
          },
        },
      }),
    ];
    const { settings, storage } = catalogContribution(
      new MemoryStorage(),
      catalog,
    );
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-parcel",
          expectedRevision: 0,
          packageId: "parcel-tracking",
          version: "0.0.1",
          catalogId: "parcel-tracking",
          catalogGeneration: "gen-one",
          contentHash,
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      (await storage.get<UserSettingsViewV1>("user-configuration"))?.packages,
    ).toEqual([
      expect.objectContaining({ packageId: "parcel-tracking", contentHash }),
    ]);

    const mismatch = catalogContribution(new MemoryStorage(), catalog);
    await mismatch.settings.readConfiguration({
      schemaVersion: 1,
      userId: "user-1",
    });
    await expect(
      mismatch.settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-wrong-hash",
          expectedRevision: 0,
          packageId: "parcel-tracking",
          version: "0.0.1",
          catalogId: "parcel-tracking",
          catalogGeneration: "gen-one",
          contentHash: "c".repeat(64),
        },
      }),
    ).rejects.toThrow('requires bundle hash "bbbb');
  });

  test("refuses an install off the pinned generation", async () => {
    const { catalog, settings } = catalogContribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });
    catalog.generation = "gen-two";

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-stale",
          expectedRevision: 0,
          packageId: "clock",
          version: "0.0.1",
          catalogId: "clock",
          catalogGeneration: "gen-two",
        },
      }),
    ).rejects.toThrow(
      'Package Catalog generation "gen-two" is not the pinned generation "gen-one"',
    );
  });

  test("refuses a Catalog entry the pinned generation does not offer", async () => {
    const { settings } = catalogContribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-absent",
          expectedRevision: 0,
          packageId: "weather",
          version: "0.0.1",
          catalogId: "weather",
          catalogGeneration: "gen-one",
        },
      }),
    ).rejects.toThrow('Catalog entry "weather" is not in pinned');
  });

  test("refuses a Catalog install whose version does not match the entry", async () => {
    const { settings } = catalogContribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-mismatch",
          expectedRevision: 0,
          packageId: "clock",
          version: "9.9.9",
          catalogId: "clock",
          catalogGeneration: "gen-one",
        },
      }),
    ).rejects.toThrow("does not offer Package");
  });

  test("leaves the compiled-in install path untouched", async () => {
    const { settings } = catalogContribution();
    await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-settings",
          expectedRevision: 0,
          packageId: "settings",
          version: "0.0.1",
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });

    // A compiled-in Package that the Catalog does not carry still installs,
    // and a Package neither source offers still does not.
    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-unknown",
          expectedRevision: 1,
          packageId: "unknown",
          version: "0.0.1",
        },
      }),
    ).rejects.toThrow("Package is not available in this application");
  });

  test("a Catalog install without a Catalog configured is refused", async () => {
    const settings = contribution();

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-clock",
          expectedRevision: 0,
          packageId: "clock",
          version: "0.0.1",
          catalogId: "clock",
          catalogGeneration: "gen-one",
        },
      }),
    ).rejects.toThrow("Package Catalog is not available");
  });
});

describe("uninstall", () => {
  test("removes the installation and leaves Connections alone", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-provider",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    await settings.createConnection("user-1", {
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready",
      safeMetadata: {},
    });
    const before = await settings.readSnapshot();

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/uninstall-package",
          commandId: "uninstall-provider",
          expectedRevision: before.revision,
          packageId: "provider-ollama-cloud",
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const after = await settings.readSnapshot();
    expect(after.packages).toEqual([]);
    // A Connection is the User's own account and outlives any Package.
    expect(after.connections.map((item) => item.connectionId)).toEqual([
      "connection-1",
    ]);
  });

  test("refuses to uninstall a Package that is not installed", async () => {
    const settings = contribution();

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/uninstall-package",
          commandId: "uninstall-absent",
          expectedRevision: 0,
          packageId: "flock",
        },
      }),
    ).rejects.toThrow('Package "flock" is not installed');
  });
});

describe("Package-level setting values", () => {
  test("applies a partial update and leaves the settings it does not name", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);
    await installOllama(settings, "user-1");

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-both",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        values: { "web-search-max-results": 2, label: "work" },
      },
    });
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-one",
        expectedRevision: 2,
        packageId: "provider-ollama-cloud",
        values: { "web-search-max-results": 5 },
      },
    });

    const view = await settings.read("user-1");
    // The projection the client reads *is* the store: one bag, one shape.
    expect(view.packages[0]).toMatchObject({
      packageId: "provider-ollama-cloud",
      values: { "web-search-max-results": 5, label: "work" },
    });
  });

  test("removes only declared setting ids and drops an emptied value bag", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-before-unset",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        values: { "web-search-max-results": 4 },
      },
    });

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "unset-value",
        expectedRevision: 2,
        packageId: "provider-ollama-cloud",
        unset: ["web-search-max-results"],
      },
    });
    expect((await settings.read("user-1")).packages[0]?.values).toBeUndefined();

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-settings",
          commandId: "unset-unknown",
          expectedRevision: 3,
          packageId: "provider-ollama-cloud",
          unset: ["unknown-setting"],
        },
      }),
    ).rejects.toThrow(/not declared by this Package/);
    expect((await settings.read("user-1")).revision).toBe(3);
  });

  test("a replayed command id returns its receipt without applying twice", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");
    const command = {
      schemaVersion: 1 as const,
      type: "user/set-package-settings" as const,
      commandId: "set-once",
      expectedRevision: 1,
      packageId: "provider-ollama-cloud",
      values: { "web-search-max-results": 4 },
    };

    const first = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command,
    });
    const replay = await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command,
    });

    expect(replay).toEqual(first);
    expect((await settings.read("user-1")).revision).toBe(2);
  });

  test("a reused command id carrying different values is refused", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-once",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        values: { "web-search-max-results": 4 },
      },
    });

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-settings",
          commandId: "set-once",
          expectedRevision: 1,
          packageId: "provider-ollama-cloud",
          values: { "web-search-max-results": 6 },
        },
      }),
    ).rejects.toThrow(/reused for a different command/);
  });

  test("refuses a value the Package's declared schema does not allow", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-settings",
          commandId: "set-out-of-range",
          expectedRevision: 1,
          packageId: "provider-ollama-cloud",
          values: { "web-search-max-results": 99 },
        },
      }),
    ).rejects.toThrow(/is above 10/);
    expect((await settings.read("user-1")).packages[0]?.values).toBeUndefined();
  });

  test("refuses a setting the Package does not declare", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-settings",
          commandId: "set-unknown",
          expectedRevision: 1,
          packageId: "provider-ollama-cloud",
          values: { "not-a-setting": "x" },
        },
      }),
    ).rejects.toThrow(/not declared by this Package/);
  });

  test("refuses settings for a Package that is not installed", async () => {
    const settings = contribution();

    await expect(
      settings.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-settings",
          commandId: "set-uninstalled",
          expectedRevision: 0,
          packageId: "provider-ollama-cloud",
          values: { "web-search-max-results": 2 },
        },
      }),
    ).rejects.toThrow(/is not installed/);
  });

  test("uninstalling drops the values, and reinstalling starts clean", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-before-uninstall",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        values: { "web-search-max-results": 2 },
      },
    });

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: "uninstall",
        expectedRevision: 2,
        packageId: "provider-ollama-cloud",
      },
    });
    expect((await settings.read("user-1")).packages).toEqual([]);

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "reinstall",
        expectedRevision: 3,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    expect((await settings.read("user-1")).packages[0]?.values).toBeUndefined();
  });

  test("a reinstall over a configured Package carries its values forward", async () => {
    const settings = contribution();
    await installOllama(settings, "user-1");
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: "set-kept",
        expectedRevision: 1,
        packageId: "provider-ollama-cloud",
        values: { label: "work" },
      },
    });
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "reinstall-same-version",
        expectedRevision: 2,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });

    expect((await settings.read("user-1")).packages[0]?.values).toEqual({
      label: "work",
    });
  });
});

describe("permanent account model migration", () => {
  test("a failed migration restores the checkpoint boundary and retries once", async () => {
    const storage = new MemoryStorage();
    const model = { connectionId: "work", providerModelId: "model-1" };
    const historical = {
      schemaVersion: 1,
      revision: 7,
      profile: { name: "Tim" },
      connections: [],
      packages: [
        {
          packageId: "custom-models",
          version: "0.0.1",
          state: "installed",
          values: { "account-model": model },
        },
      ],
    };
    await storage.put("user-configuration", historical);
    await storage.put("user-id", "tim");
    const before = new Map(storage.values);
    storage.failAfterWrite = "user-account-model:v1";
    const request = {
      schemaVersion: 1,
      userId: "tim",
      command: {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "migration-retry",
        expectedRevision: 7,
        profile: { name: "Timothy" },
      },
    };
    await expect(
      contribution(storage).executeConfiguration(request),
    ).rejects.toThrow("injected atomic write failure");
    expect(storage.values).toEqual(before);
    const receipt = await contribution(storage).executeConfiguration(request);
    expect(receipt).toMatchObject({ status: "applied", revision: 8 });
    expect(await contribution(storage).executeConfiguration(request)).toEqual(
      receipt,
    );
    expect(await contribution(storage).readSnapshot()).toMatchObject({
      revision: 8,
      accountModel: model,
    });
    expect(
      storage.values.get("user-account-model:migration-checkpoint:v1"),
    ).toEqual({ schemaVersion: 1, settings: historical });
  });

  for (const state of ["installed", "disabled"] as const) {
    test(`migrates the previous ${state} account shape and persists only current state`, async () => {
      const storage = new MemoryStorage();
      const model = { connectionId: "work", providerModelId: "model-1" };
      await storage.put("user-configuration", {
        schemaVersion: 1,
        revision: 7,
        profile: { name: "Tim" },
        connections: [],
        packages: [
          {
            packageId: "custom-models",
            version: "0.0.1",
            state,
            values: { "account-model": model },
          },
        ],
      });
      const owner = contribution(storage);
      const current = await owner.readSnapshot();
      expect(current.accountModel).toEqual(
        state === "installed" ? model : undefined,
      );
      expect(current.packages[0]!.values).not.toHaveProperty("account-model");
      const command = {
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: "save-profile",
        expectedRevision: 7,
        profile: { name: "Timothy" },
      };
      const first = await owner.executeConfiguration({
        schemaVersion: 1,
        userId: "tim",
        command,
      });
      const restarted = contribution(storage);
      expect(
        await restarted.executeConfiguration({
          schemaVersion: 1,
          userId: "tim",
          command,
        }),
      ).toEqual(first);
      const stored =
        await storage.get<UserSettingsViewV1>("user-configuration");
      const { accountModel: projectedModel, ...previousShape } =
        await restarted.readSnapshot();
      expect(stored).toEqual(previousShape);
      expect(stored).not.toHaveProperty("accountModel");
      expect(
        await storage.get<Record<string, unknown>>("user-account-model:v1"),
      ).toEqual({ schemaVersion: 1, model: projectedModel ?? null });
      expect(
        await storage.get<Record<string, unknown>>(
          "user-account-model:migration-checkpoint:v1",
        ),
      ).toMatchObject({
        schemaVersion: 1,
        settings: { revision: 7, profile: { name: "Tim" } },
      });
      expect(stored!.packages[0]!.values).not.toHaveProperty("account-model");
    });
  }
  test("account selection replays across owner restart and clearing restores Auto", async () => {
    const storage = new MemoryStorage();
    const command = {
      schemaVersion: 1,
      type: "user/set-account-model",
      commandId: "account-choice",
      expectedRevision: 0,
      model: { connectionId: "work", providerModelId: "model-1" },
    };
    const first = await contribution(storage).executeConfiguration({
      schemaVersion: 1,
      userId: "tim",
      command,
    });
    const restarted = contribution(storage);
    expect(
      await restarted.executeConfiguration({
        schemaVersion: 1,
        userId: "tim",
        command,
      }),
    ).toEqual(first);
    expect((await restarted.readSnapshot()).accountModel).toEqual(
      command.model,
    );
    await restarted.executeConfiguration({
      schemaVersion: 1,
      userId: "tim",
      command: {
        ...command,
        commandId: "auto-choice",
        expectedRevision: 1,
        model: null,
      },
    });
    expect((await restarted.readSnapshot()).accountModel).toBeUndefined();
  });
});

describe("provider choice is one durable User decision", () => {
  const provider: AvailableUserPackage = {
    packageId: "provider",
    version: "1.0.0",
    capabilities: [
      { id: "models", kind: "model", connectionTypes: ["account"] },
    ],
    dependencies: { support: "^1.0.0" },
  };
  const support: AvailableUserPackage = {
    packageId: "support",
    version: "1.0.0",
  };
  test("installs dependencies atomically, retains values on re-enable and replays after restart", async () => {
    const storage = new MemoryStorage();
    await storage.put("user-configuration", {
      schemaVersion: 1,
      revision: 4,
      profile: { name: "Tim" },
      connections: [],
      packages: [
        {
          packageId: "provider",
          version: "1.0.0",
          state: "disabled",
          values: { label: "Kept" },
        },
      ],
    });
    const owner = () =>
      createUserSettingsBackendContribution({
        storage,
        availablePackages: [provider, support],
      });
    const command = {
      schemaVersion: 1,
      commandId: "choose-provider",
      expectedRevision: 4,
      sectionId: "provider.provider",
      values: {},
    };
    const first = await owner().changeSettings("tim", "models", command);
    expect(first).toMatchObject({ status: "applied", revision: 5 });
    expect(await owner().changeSettings("tim", "models", command)).toEqual(
      first,
    );
    expect((await owner().readSnapshot()).packages).toEqual([
      { packageId: "support", version: "1.0.0", state: "installed" },
      {
        packageId: "provider",
        version: "1.0.0",
        state: "installed",
        values: { label: "Kept" },
      },
    ]);
  });
  test("missing dependency is a replayable refusal, with no partial installation", async () => {
    const storage = new MemoryStorage();
    const owner = () =>
      createUserSettingsBackendContribution({
        storage,
        availablePackages: [provider],
      });
    const command = {
      schemaVersion: 1,
      commandId: "choose-broken",
      expectedRevision: 0,
      sectionId: "provider.provider",
      values: {},
    };
    const first = await owner().changeSettings("tim", "models", command);
    expect(first).toMatchObject({ status: "rejected", revision: 0 });
    expect(await owner().changeSettings("tim", "models", command)).toEqual(
      first,
    );
    expect((await owner().readSnapshot()).packages).toEqual([]);
  });
});
