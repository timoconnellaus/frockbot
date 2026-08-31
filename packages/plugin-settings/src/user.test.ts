import { describe, expect, test } from "bun:test";
import type { CatalogEntryV1, CatalogIndexV1 } from "@frockbot/catalog-core";
import {
  capabilityAssignmentFailureV1,
  initializeBotSettingsV1,
  resolveBotExecutionPlanV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createUserSettingsBackendContribution,
  type UserPackageCatalogHost,
  type UserSettingsStorage,
} from "./user.js";

class MemoryStorage implements UserSettingsStorage {
  readonly values = new Map<string, unknown>();

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
      }
    }
    return Promise.resolve();
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function contribution(storage = new MemoryStorage()) {
  return createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "flock", version: "0.0.1" },
      { packageId: "settings", version: "0.0.1" },
      { packageId: "provider-ollama-cloud", version: "0.0.1" },
    ],
  });
}

describe("User settings backend Contribution", () => {
  test("owns durable User configuration independently of providers", async () => {
    const storage = new MemoryStorage();
    const settings = contribution(storage);

    expect(
      await settings.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).toEqual({
      schemaVersion: 1,
      revision: 0,
      profile: { name: "FrockBot user" },
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

  test("coordinates Connection dependencies in provider-neutral User state", async () => {
    const settings = contribution();
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-ollama",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    await settings.createConnection("user-1", {
      connectionId: "ollama-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready",
      providerType: "ollama-cloud",
      generation: "connection-generation",
      safeMetadata: {},
    });
    const requirement = {
      schemaVersion: 1 as const,
      packageId: "provider-ollama-cloud",
      packageVersion: "0.0.1",
      capabilityId: "ollama-cloud-models",
      connectionTypeIds: ["ollama-cloud-account"],
    };

    await expect(
      settings.claimConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
        requirement,
      ),
    ).resolves.toBe(true);
    await expect(
      settings.acknowledgeConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
      ),
    ).resolves.toBe(true);
    expect(
      (await settings.getConnection("user-1", "ollama-1"))?.safeMetadata,
    ).toMatchObject({
      dependentAssignments: [
        {
          botId: "bot-1",
          generation: "assignment-1",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          status: "acknowledged",
        },
      ],
    });
    await expect(
      settings.compensateConnectionDependency(
        "user-1",
        "ollama-1",
        "bot-1",
        "assignment-1",
      ),
    ).resolves.toBe(false);

    await settings.createConnection("user-1", {
      connectionId: "ollama-2",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Personal",
      state: "ready",
      providerType: "ollama-cloud",
      generation: "connection-generation-2",
      safeMetadata: {},
    });
    await settings.claimConnectionDependency(
      "user-1",
      "ollama-2",
      "bot-1",
      "assignment-2",
      requirement,
    );
    await settings.acknowledgeConnectionDependency(
      "user-1",
      "ollama-2",
      "bot-1",
      "assignment-2",
    );

    expect(
      (await settings.getConnection("user-1", "ollama-1"))?.safeMetadata,
    ).toMatchObject({ dependentAssignments: [] });
    expect(
      (await settings.getConnection("user-1", "ollama-2"))?.safeMetadata,
    ).toMatchObject({
      dependentAssignments: [
        {
          botId: "bot-1",
          generation: "assignment-2",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          status: "acknowledged",
        },
      ],
    });
    await expect(
      settings.releaseConnectionDependency(
        "user-1",
        "ollama-2",
        "bot-1",
        "assignment-2",
      ),
    ).resolves.toBe(true);
    await expect(
      settings.releaseConnectionDependency(
        "user-1",
        "ollama-2",
        "bot-1",
        "assignment-2",
      ),
    ).resolves.toBe(true);
    expect(
      (await settings.getConnection("user-1", "ollama-2"))?.safeMetadata,
    ).toMatchObject({ dependentAssignments: [] });
  });

  test("rejects acknowledgement from a superseded dependency claim", async () => {
    const settings = contribution();
    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-fenced-package",
        expectedRevision: 0,
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
      },
    });
    for (const connectionId of ["ollama-old", "ollama-new"]) {
      await settings.createConnection("user-1", {
        connectionId,
        packageId: "provider-ollama-cloud",
        connectionTypeId: "ollama-cloud-account",
        displayName: connectionId,
        state: "ready",
        providerType: "ollama-cloud",
        generation: `${connectionId}-generation`,
        safeMetadata: {},
      });
    }
    const requirement = {
      schemaVersion: 1 as const,
      packageId: "provider-ollama-cloud",
      packageVersion: "0.0.1",
      capabilityId: "ollama-cloud-models",
      connectionTypeIds: ["ollama-cloud-account"],
    };
    await settings.claimConnectionDependency(
      "user-1",
      "ollama-old",
      "bot-1",
      "assignment-old",
      requirement,
    );
    await settings.claimConnectionDependency(
      "user-1",
      "ollama-new",
      "bot-1",
      "assignment-new",
      requirement,
    );
    await settings.claimConnectionDependency(
      "user-1",
      "ollama-old",
      "bot-1",
      "assignment-old",
      requirement,
    );

    await expect(
      settings.acknowledgeConnectionDependency(
        "user-1",
        "ollama-old",
        "bot-1",
        "assignment-old",
      ),
    ).resolves.toBe(false);
    expect(
      (await settings.getConnection("user-1", "ollama-new"))?.safeMetadata,
    ).toMatchObject({
      dependentAssignments: [
        { generation: "assignment-new", status: "pending" },
      ],
    });
    await expect(
      settings.compensateConnectionDependency(
        "user-1",
        "ollama-old",
        "bot-1",
        "assignment-old",
      ),
    ).resolves.toBe(true);
    expect(
      (await settings.getConnection("user-1", "ollama-old"))?.safeMetadata,
    ).toMatchObject({ dependentAssignments: [] });

    await expect(
      settings.acknowledgeConnectionDependency(
        "user-1",
        "ollama-new",
        "bot-1",
        "assignment-new",
      ),
    ).resolves.toBe(true);
    expect(
      (await settings.getConnection("user-1", "ollama-old"))?.safeMetadata,
    ).toMatchObject({ dependentAssignments: [] });
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

  test("dependent Assignments become unavailable tombstones, not deletions", async () => {
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
    const assignment = {
      assignmentId: "assignment-1",
      packageId: "provider-ollama-cloud",
      capabilityId: "ollama-cloud-models",
      connectionId: "connection-1",
    };
    const packages = [
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model" as const,
            connectionTypes: ["ollama-cloud-account"],
          },
        ],
        connectionTypes: [
          {
            id: "ollama-cloud-account",
            capabilities: ["ollama-cloud-models"],
          },
        ],
      },
    ];

    const installed = await settings.readSnapshot();
    expect(
      capabilityAssignmentFailureV1({ assignment, user: installed, packages }),
    ).toBeUndefined();

    await settings.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: "uninstall-provider",
        expectedRevision: installed.revision,
        packageId: "provider-ollama-cloud",
      },
    });

    const uninstalled = await settings.readSnapshot();
    expect(
      capabilityAssignmentFailureV1({
        assignment,
        user: uninstalled,
        packages,
      }),
    ).toContain("is not installed and enabled");
    expect(
      resolveBotExecutionPlanV1({
        bot: {
          ...initializeBotSettingsV1("bot-1"),
          assignments: [{ ...assignment, state: "enabled" }],
        },
        user: uninstalled,
        packages,
      }).assignments,
    ).toEqual([{ ...assignment, state: "unavailable" }]);
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
