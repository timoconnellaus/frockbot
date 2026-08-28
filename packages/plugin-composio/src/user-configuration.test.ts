import { describe, expect, test } from "bun:test";
import type {
  ConnectionView,
  UserConfigurationCommandV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createComposioUserBackendContribution,
  deriveRevocationCompensations,
} from "./user-configuration.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

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

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(alarmAt: number): Promise<void> {
    this.alarmAt = alarmAt;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

function backendHost(
  storage: MemoryStorage,
  listConnectedAccounts: () => Promise<
    Array<{ id: string; status: string; toolkitSlug: string; alias?: string }>
  > = () => Promise.resolve([]),
) {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {} as never,
    availablePackages: [{ packageId: "composio", version: "0.0.1" }],
    listConnectedAccounts,
  };
}

async function makeReconciliationDue(storage: MemoryStorage): Promise<void> {
  const settings = await storage.get<UserSettingsViewV1>(
    "user-configuration",
  );
  if (!settings) throw new Error("user configuration was not stored");
  await storage.put("user-configuration", {
    ...settings,
    connections: settings.connections.map((item) => ({
      ...item,
      safeMetadata: { ...item.safeMetadata, reconciliationRetryAt: 0 },
    })),
  } satisfies UserSettingsViewV1);
}

function connection(
  safeMetadata: ConnectionView["safeMetadata"],
): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "composio",
    connectionTypeId: "gmail",
    displayName: "Gmail",
    state: "ready",
    safeMetadata,
  };
}

describe("Connection revocation dependencies", () => {
  test("uses only acknowledged explicit Assignments", () => {
    expect(
      deriveRevocationCompensations(
        connection({
          targetBotId: "oauth-initiator",
          dependentAssignments: [
            { botId: "pending", generation: "gen-pending", status: "pending" },
            {
              botId: "acknowledged",
              generation: "gen-acknowledged",
              status: "acknowledged",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        botId: "acknowledged",
        id: "revoke:connection-1:acknowledged:gen-acknowledged",
        expectedGeneration: "gen-acknowledged",
      },
    ]);
  });

  test("accepts legacy Bot metadata only with an exact generation", () => {
    expect(
      deriveRevocationCompensations(connection({ targetBotId: "legacy-bot" })),
    ).toEqual([]);
    expect(
      deriveRevocationCompensations(
        connection({
          targetBotId: "legacy-bot",
          assignmentGeneration: "gen-legacy",
        }),
      ),
    ).toEqual([
      {
        botId: "legacy-bot",
        id: "revoke:connection-1:legacy-bot:gen-legacy",
        expectedGeneration: "gen-legacy",
      },
    ]);
  });
});

describe("Connection dependency admission", () => {
  test("replays a Package receipt before deployment availability changes", async () => {
    const storage = new MemoryStorage();
    const host = backendHost(storage);
    const installed = createComposioUserBackendContribution({
      ...host,
    });
    const command: UserConfigurationCommandV1 = {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-composio",
      expectedRevision: 0,
      packageId: "composio",
      version: "0.0.1",
    };
    const request = {
      schemaVersion: 1 as const,
      userId: "user-1",
      command,
    };
    const receipt = await installed.executeConfiguration(request);
    const redeployed = createComposioUserBackendContribution({
      ...host,
      availablePackages: [],
    });

    await expect(redeployed.executeConfiguration(request)).resolves.toEqual(
      receipt,
    );
    await expect(
      redeployed.executeConfiguration({
        ...request,
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: command.commandId,
          expectedRevision: 0,
          profile: { name: "Collision" },
        },
      }),
    ).rejects.toThrow(
      'Configuration command idempotency key "install-composio" was reused for a different command',
    );
    await expect(
      redeployed.executeConfiguration({
        ...request,
        command: {
          ...command,
          commandId: "install-after-removal",
          expectedRevision: 1,
        },
      }),
    ).rejects.toThrow("Package is not available");
    await expect(
      redeployed.readConfiguration({ schemaVersion: 1, userId: "user-1" }),
    ).resolves.toMatchObject({
      revision: 1,
      profile: { name: "FrockBot user" },
      packages: [{ packageId: "composio", state: "installed" }],
    });
  });

  test("atomically enforces the Package and Connection Type requirement", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution({
      ...backendHost(storage),
    });
    const execute = (command: UserConfigurationCommandV1) =>
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command,
      });
    const read = () =>
      contribution.readConfiguration({ schemaVersion: 1, userId: "user-1" });

    await expect(
      contribution.readConfiguration({ schemaVersion: 1, userId: 42 }),
    ).rejects.toThrow("userId is invalid");
    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "malformed-profile",
          expectedRevision: 0,
          profile: { name: 42 },
        },
      }),
    ).rejects.toThrow("profile.name must be a string");
    await expect(
      execute({
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-unknown",
        expectedRevision: 0,
        packageId: "unknown",
        version: "1.0.0",
      }),
    ).rejects.toThrow("Package is not available");
    expect((await read()).revision).toBe(0);

    await execute({
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-composio",
      expectedRevision: 0,
      packageId: "composio",
      version: "0.0.1",
    });
    await contribution.startConnection("user-1", {
      connectionId: "gmail-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await contribution.finishConnectionAuthorization("user-1", "gmail-1", {
      state: "ready",
    });

    const requirement = {
      schemaVersion: 1 as const,
      packageId: "composio",
      packageVersion: "0.0.1",
      capabilityId: "gmail-tools",
      connectionTypeIds: ["gmail"],
    };
    expect(
      await contribution.claimConnectionDependency(
        "user-1",
        "gmail-1",
        "primary",
        "generation-1",
        { ...requirement, packageVersion: "9.9.9" },
      ),
    ).toBe(false);
    expect(
      await contribution.claimConnectionDependency(
        "user-1",
        "gmail-1",
        "primary",
        "generation-1",
        { ...requirement, connectionTypeIds: ["calendar"] },
      ),
    ).toBe(false);
    const beforeClaim = await read();
    expect(beforeClaim.revision).toBe(3);
    expect(beforeClaim.connections[0]?.safeMetadata).not.toHaveProperty(
      "dependentAssignments",
    );

    expect(
      await contribution.claimConnectionDependency(
        "user-1",
        "gmail-1",
        "primary",
        "generation-1",
        requirement,
      ),
    ).toBe(true);
    expect((await read()).connections[0]?.safeMetadata).toMatchObject({
      dependentAssignments: [
        {
          botId: "primary",
          generation: "generation-1",
          status: "pending",
        },
      ],
    });
  });
});

describe("Connection provider reconciliation alarms", () => {
  test("recovers a lost Link response after Durable Object eviction", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await admitted.startConnection("user-1", {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt: Date.now() + 10 * 60_000,
      },
    });
    await admitted.requireConnectionReconciliation(
      "user-1",
      "link-command",
      "link",
      "Connect Link outcome requires reconciliation",
    );

    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    await makeReconciliationDue(storage);
    let reads = 0;
    const recovered = createComposioUserBackendContribution(
      backendHost(storage, () => {
        reads += 1;
        return Promise.resolve([
          {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        ]);
      }),
    );

    await recovered.alarm();

    expect(reads).toBe(1);
    expect(
      await recovered.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "ready",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
      },
    });
    expect(storage.alarmAt).toBeUndefined();
  });

  test("keeps failed reads scheduled without repeating the Link effect", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, () => Promise.reject(new Error("read unavailable"))),
    );
    await contribution.startConnection("user-1", {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt: Date.now() + 10 * 60_000,
      },
    });
    await contribution.requireConnectionReconciliation(
      "user-1",
      "link-command",
      "link",
      "Connect Link outcome requires reconciliation",
    );
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "reconciliation-required",
      safeMetadata: { reconciliationOperation: "link" },
    });
  });

  test("finishes uncertain revocation through a provider read after eviction", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await admitted.startConnection("user-1", {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await admitted.recordConnectLinkResult("user-1", "connection-1", {
      connectedAccountId: "account-1",
      providerAlias: "connection-1",
      toolkitSlug: "gmail",
    });
    await admitted.finishConnectionAuthorization(
      "user-1",
      "connection-1",
      { state: "ready" },
    );
    expect(
      (await admitted.claimConnectionRevocation("user-1", "connection-1"))
        .phase,
    ).toBe("provider");
    await admitted.requireConnectionReconciliation(
      "user-1",
      "connection-1",
      "revoke",
      "Revocation outcome requires reconciliation",
    );
    await makeReconciliationDue(storage);
    let reads = 0;
    const recovered = createComposioUserBackendContribution(
      backendHost(storage, () => {
        reads += 1;
        return Promise.resolve([
          {
            id: "account-1",
            status: "REVOKED",
            toolkitSlug: "gmail",
          },
        ]);
      }),
    );

    await recovered.alarm();

    expect(reads).toBe(1);
    expect(
      await recovered.getConnection("user-1", "connection-1"),
    ).toMatchObject({ state: "revoked" });
    expect(storage.alarmAt).toBeUndefined();
  });
});
