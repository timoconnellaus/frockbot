import { describe, expect, test } from "bun:test";
import {
  USER_PROFILE_PLACEHOLDER_NAME_V1,
  type ConnectionView,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createComposioUserBackendContribution,
  deriveRevocationCompensations,
} from "./user-configuration.js";
import { ComposioClient } from "./composio-client.js";
import { ComposioConnectionCoordinator } from "./connections.js";
import { reconcileComposioProviderConnection } from "./provider-reconciliation.js";
import type {
  ComposioProviderReconciliationRequest,
  ComposioProviderReconciliationResult,
} from "./provider-reconciliation.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;
  interruptAfterNextPut = false;

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
    if (this.interruptAfterNextPut) {
      this.interruptAfterNextPut = false;
      return Promise.reject(new Error("Durable Object interrupted after put"));
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
  reconcileProviderConnection: (
    request: ComposioProviderReconciliationRequest,
  ) => Promise<ComposioProviderReconciliationResult> = () =>
    Promise.resolve({ status: "pending" }),
  revokeConnectedAccount: (
    connectedAccountId: string,
  ) => Promise<unknown> = () => Promise.resolve({ success: true }),
) {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {} as never,
    availablePackages: [{ packageId: "composio", version: "0.0.1" }],
    reconcileProviderConnection,
    revokeConnectedAccount,
  };
}

async function makeReconciliationDue(storage: MemoryStorage): Promise<void> {
  const settings = await storage.get<UserSettingsViewV1>("user-configuration");
  if (!settings) throw new Error("user configuration was not stored");
  await storage.put("user-configuration", {
    ...settings,
    connections: settings.connections.map((item) => ({
      ...item,
      safeMetadata: { ...item.safeMetadata, reconciliationRetryAt: 0 },
    })),
  } satisfies UserSettingsViewV1);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

async function startInstalledConnection(
  contribution: ReturnType<typeof createComposioUserBackendContribution>,
  input: Parameters<
    ReturnType<typeof createComposioUserBackendContribution>["startConnection"]
  >[1],
): Promise<boolean> {
  const current = await contribution.read("user-1");
  if (!current.packages.some((pkg) => pkg.packageId === input.packageId)) {
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: `install-${input.packageId}`,
        expectedRevision: current.revision,
        packageId: input.packageId,
        version: "0.0.1",
      },
    });
  }
  return contribution.startConnection("user-1", input);
}

describe("Connection revocation dependencies", () => {
  test("uses only acknowledged explicit Assignments", async () => {
    expect(
      await deriveRevocationCompensations(
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
        id: expect.stringMatching(/^revocation-[a-f0-9]{64}$/),
        expectedGeneration: "gen-acknowledged",
      },
    ]);
  });

  test("keeps compensation identifiers unique and within the RPC bound", async () => {
    const generation = "g".repeat(128);
    const [first, second] = await deriveRevocationCompensations(
      connection({
        dependentAssignments: [
          { botId: "primary", generation, status: "acknowledged" },
          { botId: "secondary", generation, status: "acknowledged" },
        ],
      }),
    );

    expect(first).toMatchObject({ expectedGeneration: generation });
    expect(second).toMatchObject({ expectedGeneration: generation });
    expect(first?.id).not.toBe(second?.id);
    expect(first?.id.length).toBeLessThanOrEqual(128);
    expect(second?.id.length).toBeLessThanOrEqual(128);
  });

  test("ignores legacy Bot metadata even when it has a generation", async () => {
    expect(
      await deriveRevocationCompensations(
        connection({
          targetBotId: "legacy-bot",
          assignmentGeneration: "gen-legacy",
        }),
      ),
    ).toEqual([]);
  });

  test("retries durable Bot compensation through the versioned RPC envelope", async () => {
    const storage = new MemoryStorage();
    const requests: unknown[] = [];
    await storage.put({
      "user-id": "user-1",
      "user-configuration": {
        schemaVersion: 1,
        revision: 1,
        profile: { name: "User" },
        packages: [],
        connections: [
          {
            ...connection({
              connectedAccountId: "account-1",
              revocationProviderCompleted: true,
              assignmentCompensationPending: true,
              assignmentCompensations: [
                {
                  botId: "primary",
                  id: "compensation-1",
                  expectedGeneration: "generation-1",
                },
              ],
              compensationRetryAt: 0,
            }),
            state: "revoking",
          },
        ],
      } satisfies UserSettingsViewV1,
    });
    const contribution = createComposioUserBackendContribution({
      ...backendHost(storage),
      env: {
        BOT_STATES: {
          idFromName: (name: string) => name,
          get: () => ({
            markConnectionUnavailable: (request: unknown) => {
              requests.push(request);
              return Promise.resolve("applied" as const);
            },
          }),
        },
      } as never,
    });

    await contribution.alarm();

    expect(requests).toEqual([
      {
        schemaVersion: 1,
        userId: "user-1",
        botId: "primary",
        connectionId: "connection-1",
        compensation: {
          id: "compensation-1",
          expectedGeneration: "generation-1",
        },
      },
    ]);
    expect(
      await contribution.getConnection("user-1", "connection-1"),
    ).toMatchObject({ state: "revoked" });
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
      profile: { name: USER_PROFILE_PLACEHOLDER_NAME_V1 },
      packages: [{ packageId: "composio", state: "installed" }],
    });
  });

  test("rejects re-enabling a Package version removed from the application", async () => {
    const storage = new MemoryStorage();
    const host = backendHost(storage);
    const contribution = createComposioUserBackendContribution(host);
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-composio",
        expectedRevision: 1,
        packageId: "composio",
        enabled: false,
      },
    });
    const upgraded = createComposioUserBackendContribution({
      ...host,
      availablePackages: [{ packageId: "composio", version: "0.0.2" }],
    });

    await expect(
      upgraded.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/set-package-enabled",
          commandId: "enable-composio",
          expectedRevision: 2,
          packageId: "composio",
          enabled: true,
        },
      }),
    ).rejects.toThrow("Package is not available");
    await expect(upgraded.read("user-1")).resolves.toMatchObject({
      revision: 2,
      packages: [{ packageId: "composio", state: "disabled" }],
    });
  });

  test("rejects Connection admission after its Package is disabled", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-composio",
        expectedRevision: 1,
        packageId: "composio",
        enabled: false,
      },
    });

    await expect(
      contribution.startConnection("user-1", {
        connectionId: "gmail-1",
        packageId: "composio",
        connectionTypeId: "gmail",
        displayName: "Gmail",
      }),
    ).rejects.toThrow('Package "composio" is not installed');
    expect((await contribution.read("user-1")).connections).toEqual([]);
  });

  test("rejects Connection admission when the installed Package version is unavailable", async () => {
    const storage = new MemoryStorage();
    const host = backendHost(storage);
    const contribution = createComposioUserBackendContribution(host);
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    const upgraded = createComposioUserBackendContribution({
      ...host,
      availablePackages: [{ packageId: "composio", version: "0.0.2" }],
    });

    await expect(
      upgraded.startConnection("user-1", {
        connectionId: "gmail-1",
        packageId: "composio",
        connectionTypeId: "gmail",
        displayName: "Gmail",
      }),
    ).rejects.toThrow('Package "composio" is not available');
    expect((await upgraded.read("user-1")).connections).toEqual([]);
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
    await startInstalledConnection(contribution, {
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
  test("replays terminal start success after alarm reconciliation", async () => {
    const storage = new MemoryStorage();
    let alarmReads = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, () => {
        alarmReads += 1;
        return Promise.resolve({
          status: "active",
          account: {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
      }),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    let createCalls = 0;
    let coordinatorReads = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          createCalls += 1;
          return Promise.reject(new Error("Link response was lost"));
        }
        coordinatorReads += 1;
        return Promise.reject(new Error("Coordinator provider read attempted"));
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const authorizationStateExpiresAt = Date.now() + 10 * 60_000;
    const command = {
      commandId: "link-command",
      connectionTypeId: "gmail",
      callbackState: "signed-state",
      authorizationStateId: "authorization-state",
      authorizationStateExpiresAt,
    };

    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "Link response was lost",
    );
    await makeReconciliationDue(storage);
    await contribution.alarm();
    const readySettings =
      await storage.get<UserSettingsViewV1>("user-configuration");
    if (!readySettings) throw new Error("user configuration was not stored");
    await storage.put("user-configuration", {
      ...readySettings,
      connections: readySettings.connections.map((connection) => ({
        ...connection,
        safeMetadata: {
          ...connection.safeMetadata,
          authorizationStateExpiresAt: Date.now() - 1,
        },
      })),
    } satisfies UserSettingsViewV1);
    const recovered = await coordinator.start("user-1", command);
    const replayed = await coordinator.start("user-1", command);

    expect(replayed).toEqual(recovered);
    expect(recovered).toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "link-command",
    });
    expect(recovered).not.toHaveProperty("redirectUrl");
    expect(recovered).not.toHaveProperty("expiresAt");
    expect(createCalls).toBe(1);
    expect(alarmReads).toBe(1);
    expect(coordinatorReads).toBe(0);
  });

  test("replays ready when an alarm wins an explicit retry race", async () => {
    const storage = new MemoryStorage();
    let alarmReads = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, () => {
        alarmReads += 1;
        return Promise.resolve({
          status: "active",
          account: {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
      }),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    const providerStarted = deferred<void>();
    const providerResult = deferred<Response>();
    let createCalls = 0;
    let coordinatorReads = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          createCalls += 1;
          return Promise.reject(new Error("Link response was lost"));
        }
        coordinatorReads += 1;
        providerStarted.resolve();
        return providerResult.promise;
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const command = {
      commandId: "link-command",
      connectionTypeId: "gmail",
      callbackState: "signed-state",
      authorizationStateId: "authorization-state",
      authorizationStateExpiresAt: Date.now() + 10 * 60_000,
    };

    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "Link response was lost",
    );
    await makeReconciliationDue(storage);
    const retry = coordinator.start("user-1", command);
    await providerStarted.promise;
    await contribution.alarm();
    providerResult.resolve(
      Response.json({
        items: [
          {
            id: "account-1",
            status: "ACTIVE",
            alias: "link-command",
            toolkit: { slug: "gmail" },
          },
        ],
      }),
    );

    await expect(retry).resolves.toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "link-command",
    });
    await expect(coordinator.start("user-1", command)).resolves.toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "link-command",
    });
    expect(createCalls).toBe(1);
    expect(alarmReads).toBe(1);
    expect(coordinatorReads).toBe(1);
  });

  test("accepts provider-confirmed ACTIVE when callback expires during read", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    const providerStarted = deferred<void>();
    const providerResult = deferred<Response>();
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          return Promise.reject(new Error("Link response was lost"));
        }
        providerStarted.resolve();
        return providerResult.promise;
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const command = {
      commandId: "link-command",
      connectionTypeId: "gmail",
      callbackState: "signed-state",
      authorizationStateId: "authorization-state",
      authorizationStateExpiresAt: Date.now() + 10 * 60_000,
    };

    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "Link response was lost",
    );
    const retry = coordinator.start("user-1", command);
    await providerStarted.promise;
    const settings =
      await storage.get<UserSettingsViewV1>("user-configuration");
    if (!settings) throw new Error("user configuration was not stored");
    await storage.put("user-configuration", {
      ...settings,
      connections: settings.connections.map((connection) => ({
        ...connection,
        safeMetadata: {
          ...connection.safeMetadata,
          authorizationStateExpiresAt: Date.now() - 1,
        },
      })),
    } satisfies UserSettingsViewV1);
    providerResult.resolve(
      Response.json({
        items: [
          {
            id: "account-1",
            status: "ACTIVE",
            alias: "link-command",
            toolkit: { slug: "gmail" },
          },
        ],
      }),
    );

    await expect(retry).resolves.toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "link-command",
    });
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({ state: "ready" });
  });

  test("terminalizes recovered ACTIVE state before exposing its response", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    let createCalls = 0;
    let providerReads = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input, init) => {
        if (init?.method === "POST") {
          createCalls += 1;
          return Promise.reject(new Error("Link response was lost"));
        }
        providerReads += 1;
        return Promise.resolve(
          Response.json({
            items: [
              {
                id: "account-1",
                status: "ACTIVE",
                alias: "link-command",
                toolkit: { slug: "gmail" },
              },
            ],
          }),
        );
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const command = {
      commandId: "link-command",
      connectionTypeId: "gmail",
      callbackState: "signed-state",
      authorizationStateId: "authorization-state",
      authorizationStateExpiresAt: Date.now() + 10 * 60_000,
    };

    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "Link response was lost",
    );
    const recovered = await coordinator.start("user-1", command);
    const replayed = await coordinator.start("user-1", command);

    expect(createCalls).toBe(1);
    expect(providerReads).toBe(1);
    expect(replayed).toEqual(recovered);
    expect(recovered).toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "link-command",
    });
    await expect(
      coordinator.start("user-1", { ...command, alias: "Work" }),
    ).rejects.toThrow(
      'Connection command idempotency key "link-command" was reused for a different command',
    );
    await expect(
      coordinator.start("user-1", {
        ...command,
        nativeReturnNonce: "native-return-2",
      }),
    ).rejects.toThrow(
      'Connection command idempotency key "link-command" was reused for a different command',
    );
    expect(createCalls).toBe(1);
    expect(providerReads).toBe(1);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "ready",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
      },
    });
  });

  test("serializes simultaneous Link effects for one Connection Type", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    const firstLink = deferred<Response>();
    const firstLinkStarted = deferred<void>();
    let createCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () => {
        createCalls += 1;
        if (createCalls === 1) {
          firstLinkStarted.resolve();
          return firstLink.promise;
        }
        return Promise.resolve(
          Response.json({
            connected_account_id: "account-2",
            redirect_url: "https://connect.example/second",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const first = coordinator.start("user-1", {
      commandId: "first-command",
      connectionTypeId: "gmail",
      callbackState: "first-signed-state",
      authorizationStateId: "first-state",
      authorizationStateExpiresAt: Date.now() + 60_000,
    });
    await firstLinkStarted.promise;

    await expect(
      coordinator.start("user-1", {
        commandId: "second-command",
        connectionTypeId: "gmail",
        callbackState: "second-signed-state",
        authorizationStateId: "second-state",
        authorizationStateExpiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(
      "Previous Connection authorization requires reconciliation",
    );
    expect(createCalls).toBe(1);

    firstLink.resolve(
      Response.json({
        connected_account_id: "account-1",
        redirect_url: "https://connect.example/first",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await expect(first).resolves.toMatchObject({
      status: "authorization-required",
      connectionId: "first-command",
    });
    await expect(
      coordinator.fail(
        "user-1",
        "first-command",
        "Authorization failed",
        "first-state",
      ),
    ).resolves.toMatchObject({ status: "failed" });

    await expect(
      coordinator.start("user-1", {
        commandId: "second-command",
        connectionTypeId: "gmail",
        callbackState: "second-signed-state",
        authorizationStateId: "second-state",
        authorizationStateExpiresAt: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      connectionId: "second-command",
    });
    expect(createCalls).toBe(2);
  });

  test("retires a pending account after a lost Link response", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, (request) => {
        if (request.operation !== "revoke") {
          throw new Error("Unexpected Link reconciliation alarm");
        }
        return Promise.resolve({
          status: "revoked",
          account: {
            id: "account-1",
            status: "REVOKED",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
      }),
    );
    await contribution.executeConfiguration({
      schemaVersion: 1,
      userId: "user-1",
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-composio",
        expectedRevision: 0,
        packageId: "composio",
        version: "0.0.1",
      },
    });
    let createCalls = 0;
    let providerReads = 0;
    let revokeCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (input, init) => {
        const url = String(input);
        if (url.endsWith("/connected_accounts/link")) {
          createCalls += 1;
          if (createCalls === 1) {
            return Promise.reject(new Error("Link response was lost"));
          }
          return Promise.resolve(
            Response.json({
              connected_account_id: "account-2",
              redirect_url: "https://connect.example/authorize",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
        }
        if (url.endsWith("/connected_accounts/account-1/revoke")) {
          revokeCalls += 1;
          return Promise.resolve(Response.json({ success: true }));
        }
        if (url.includes("/connected_accounts?")) {
          providerReads += 1;
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: "account-1",
                  status: "INITIALIZING",
                  alias: "link-command",
                  toolkit: { slug: "gmail" },
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected Composio request: ${url} ${init?.method}`);
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
    });
    const command = {
      commandId: "link-command",
      connectionTypeId: "gmail",
      callbackState: "signed-state",
      authorizationStateId: "authorization-state",
      authorizationStateExpiresAt: Date.now() + 10 * 60_000,
    };

    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "Link response was lost",
    );
    await expect(coordinator.start("user-1", command)).rejects.toThrow(
      "cleanup requires reconciliation",
    );
    expect(createCalls).toBe(1);
    expect(providerReads).toBe(1);
    expect(revokeCalls).toBe(1);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "reconciliation-required",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
        lostLinkCleanup: true,
        reconciliationOperation: "revoke",
      },
    });

    await expect(
      coordinator.start("user-1", {
        ...command,
        commandId: "replacement-command",
        authorizationStateId: "replacement-state",
      }),
    ).rejects.toThrow(
      "Previous Connection authorization requires reconciliation",
    );
    expect(createCalls).toBe(1);

    await makeReconciliationDue(storage);
    await contribution.alarm();

    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({ state: "revoked" });
    await expect(
      coordinator.start("user-1", {
        ...command,
        commandId: "replacement-command",
        authorizationStateId: "replacement-state",
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      connectionId: "replacement-command",
    });
    expect(createCalls).toBe(2);
  });

  test("consumes failed callback state and replays its terminal result", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage),
    );
    const authorizationStateExpiresAt = Date.now() + 60_000;
    await startInstalledConnection(contribution, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        authorizationStateId: "authorization-state",
        authorizationStateExpiresAt,
        returnTarget: "desktop",
      },
    });
    const coordinator = new ComposioConnectionCoordinator({
      client: {} as ComposioClient,
      store: contribution,
      callbackBaseUrl: "https://app.example.com",
      connectionTypes: {},
    });

    await expect(
      coordinator.fail(
        "user-1",
        "link-command",
        "Authorization failed",
        "authorization-state",
      ),
    ).resolves.toEqual({
      returnTarget: "desktop",
      status: "failed",
      nativeReturnNonce: undefined,
    });
    const first = await contribution.read("user-1");
    expect(first.connections[0]).toMatchObject({
      state: "failed",
      safeMetadata: { authorizationStateConsumed: true },
    });

    await expect(
      coordinator.fail(
        "user-1",
        "link-command",
        "Different replayed failure",
        "authorization-state",
      ),
    ).resolves.toEqual({
      returnTarget: "desktop",
      status: "failed",
      nativeReturnNonce: undefined,
    });
    expect((await contribution.read("user-1")).revision).toBe(first.revision);
  });

  test("survives interruption immediately after recovered ACTIVE commit", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, () => {
        storage.interruptAfterNextPut = true;
        return Promise.resolve({
          status: "active",
          account: {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
      }),
    );
    await startInstalledConnection(contribution, {
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

    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "ready",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
      },
    });
  });

  test.each([
    {
      name: "ACTIVE",
      result: {
        status: "active" as const,
        account: {
          id: "account-1",
          status: "ACTIVE",
          toolkitSlug: "gmail",
          alias: "link-command",
        },
      },
    },
    {
      name: "FAILED",
      result: {
        status: "failed" as const,
        account: {
          id: "account-1",
          status: "FAILED",
          toolkitSlug: "gmail",
          alias: "link-command",
        },
      },
    },
  ])(
    "preserves concurrent revocation across $name recovery",
    async ({ result }) => {
      const storage = new MemoryStorage();
      const providerStarted = deferred<void>();
      const providerResult = deferred<ComposioProviderReconciliationResult>();
      const contribution = createComposioUserBackendContribution(
        backendHost(storage, () => {
          providerStarted.resolve();
          return providerResult.promise;
        }),
      );
      await startInstalledConnection(contribution, {
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

      const alarm = contribution.alarm();
      await providerStarted.promise;
      await contribution.claimConnectionRevocation("user-1", "link-command");
      providerResult.resolve(result);
      await alarm;

      expect(
        await contribution.getConnection("user-1", "link-command"),
      ).toMatchObject({
        state: "reconciliation-required",
        safeMetadata: {
          reconciliationOperation: "link",
          revocationRequested: true,
        },
      });
      expect(storage.alarmAt).toBeGreaterThan(Date.now());
    },
  );

  test("recovers a lost Link response after Durable Object eviction", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await startInstalledConnection(admitted, {
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
        return Promise.resolve({
          status: "active" as const,
          account: {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
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
    await startInstalledConnection(contribution, {
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

  test("retires an INITIALIZING identity through verified cleanup", async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    let revokeCalls = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(
        storage,
        (request) => {
          reads += 1;
          if (request.operation === "link") {
            return Promise.resolve({
              status: "pending" as const,
              account: {
                id: "account-1",
                status: "INITIALIZING",
                toolkitSlug: "gmail",
                alias: "link-command",
              },
            });
          }
          return Promise.resolve({
            status: "revoked" as const,
            account: {
              id: "account-1",
              status: "REVOKED",
              toolkitSlug: "gmail",
              alias: "link-command",
            },
          });
        },
        () => {
          revokeCalls += 1;
          return Promise.resolve({ success: true });
        },
      ),
    );
    await startInstalledConnection(contribution, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt: Date.now() - 1,
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

    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "reconciliation-required",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
        lostLinkCleanup: true,
        reconciliationOperation: "revoke",
      },
    });
    expect(revokeCalls).toBe(1);
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(reads).toBe(2);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "revoked",
      safeMetadata: { connectedAccountId: "account-1" },
    });
    expect(storage.alarmAt).toBeUndefined();
  });

  test("keeps a provider-absent expired Link pending for durable reconciliation", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    const authorizationStateExpiresAt = Date.now() + 60_000;
    const linkExpiresAt = new Date(Date.now() + 30_000).toISOString();
    await startInstalledConnection(admitted, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt,
      },
    });
    await admitted.recordConnectLinkResult("user-1", "link-command", {
      connectedAccountId: "account-1",
      providerAlias: "link-command",
      toolkitSlug: "gmail",
      redirectUrl: "https://connect.example/authorize",
      expiresAt: linkExpiresAt,
      authorizationStateExpiresAt,
    });

    expect(storage.alarmAt).toBe(Date.parse(linkExpiresAt));
    const settings =
      await storage.get<UserSettingsViewV1>("user-configuration");
    if (!settings) throw new Error("user configuration was not stored");
    await storage.put("user-configuration", {
      ...settings,
      connections: settings.connections.map((item) => ({
        ...item,
        safeMetadata: {
          ...item.safeMetadata,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
      })),
    } satisfies UserSettingsViewV1);
    let reads = 0;
    const recovered = createComposioUserBackendContribution(
      backendHost(storage, () => {
        reads += 1;
        return Promise.resolve({ status: "absent" });
      }),
    );

    await recovered.alarm();

    expect(reads).toBe(1);
    expect(
      await recovered.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "reconciliation-required",
      failure: "Expired authorization requires provider reconciliation",
      safeMetadata: {
        reconciliationOperation: "link",
        connectedAccountId: "account-1",
      },
    });
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
  });

  test("schedules no-account revocation reconciliation after eviction", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await startInstalledConnection(admitted, {
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
    await admitted.finishConnectionAuthorization("user-1", "link-command", {
      state: "failed",
      failure: "Authorization failed",
    });
    expect(storage.alarmAt).toBeUndefined();

    const recovered = createComposioUserBackendContribution(
      backendHost(storage),
    );
    const claim = await recovered.claimConnectionRevocation(
      "user-1",
      "link-command",
    );

    expect(claim).toMatchObject({
      phase: "pending",
      connection: {
        state: "reconciliation-required",
        safeMetadata: {
          reconciliationOperation: "link",
          revocationRequested: true,
        },
      },
    });
    const retryAt = claim.connection.safeMetadata.reconciliationRetryAt;
    if (typeof retryAt !== "number") {
      throw new Error("expected a numeric reconciliation retry deadline");
    }
    expect(storage.alarmAt).toBe(retryAt);
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
  });

  test("finishes uncertain revocation through a provider read after eviction", async () => {
    const storage = new MemoryStorage();
    const admitted = createComposioUserBackendContribution(
      backendHost(storage),
    );
    await startInstalledConnection(admitted, {
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
    await admitted.finishConnectionAuthorization("user-1", "connection-1", {
      state: "ready",
    });
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
        return Promise.resolve({ status: "revoked" });
      }),
    );

    await recovered.alarm();

    expect(reads).toBe(1);
    expect(
      await recovered.getConnection("user-1", "connection-1"),
    ).toMatchObject({ state: "revoked" });
    expect(storage.alarmAt).toBeUndefined();
  });

  test("accepts an ACTIVE account after callback authorization expires", async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, () => {
        reads += 1;
        return Promise.resolve({
          status: "active",
          account: {
            id: "account-1",
            status: "ACTIVE",
            toolkitSlug: "gmail",
            alias: "link-command",
          },
        });
      }),
    );
    await startInstalledConnection(contribution, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt: Date.now() - 1,
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

    expect(reads).toBe(1);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "ready",
      safeMetadata: {
        connectedAccountId: "account-1",
        authorizationStateConsumed: true,
      },
    });
    expect(storage.alarmAt).toBeUndefined();
  });

  test("dispatches a requested revocation after Link identity recovery", async () => {
    const storage = new MemoryStorage();
    let revokeCalls = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(
        storage,
        () =>
          Promise.resolve({
            status: "pending",
            account: {
              id: "account-1",
              status: "INITIALIZING",
              toolkitSlug: "gmail",
              alias: "link-command",
            },
          }),
        () => {
          revokeCalls += 1;
          return Promise.resolve({ success: true });
        },
      ),
    );
    await startInstalledConnection(contribution, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        authorizationStateExpiresAt: Date.now() + 60_000,
      },
    });
    await contribution.requireConnectionReconciliation(
      "user-1",
      "link-command",
      "link",
      "Connect Link outcome requires reconciliation",
    );
    await contribution.claimConnectionRevocation("user-1", "link-command");
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(revokeCalls).toBe(1);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "revoked",
      safeMetadata: { connectedAccountId: "account-1" },
    });
  });

  test("keeps expired revocation scheduled until REVOKED is observed", async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    let revokeCalls = 0;
    const contribution = createComposioUserBackendContribution(
      backendHost(
        storage,
        () => {
          reads += 1;
          return Promise.resolve(
            reads === 1
              ? { status: "pending" as const }
              : {
                  status: "revoked" as const,
                  account: {
                    id: "account-1",
                    status: "REVOKED",
                    toolkitSlug: "gmail",
                    alias: "link-command",
                  },
                },
          );
        },
        () => {
          revokeCalls += 1;
          return Promise.resolve({ success: true });
        },
      ),
    );
    await startInstalledConnection(contribution, {
      connectionId: "link-command",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      safeMetadata: {
        providerAlias: "link-command",
        toolkitSlug: "gmail",
        expiresAt: new Date(Date.now() - 1).toISOString(),
        authorizationStateExpiresAt: Date.now() - 1,
      },
    });
    await contribution.requireConnectionReconciliation(
      "user-1",
      "link-command",
      "link",
      "Connect Link outcome requires reconciliation",
    );
    await contribution.claimConnectionRevocation("user-1", "link-command");
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(reads).toBe(1);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "reconciliation-required",
      safeMetadata: {
        reconciliationOperation: "link",
        revocationRequested: true,
      },
    });
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(reads).toBe(2);
    expect(revokeCalls).toBe(0);
    expect(
      await contribution.getConnection("user-1", "link-command"),
    ).toMatchObject({
      state: "revoked",
      safeMetadata: { connectedAccountId: "account-1" },
    });
    expect(storage.alarmAt).toBeUndefined();
  });

  test("keeps non-definitive revocation status scheduled", async () => {
    const storage = new MemoryStorage();
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(
          Response.json({
            id: "account-1",
            user_id: "user-1",
            status: "FAILED",
            toolkit: { slug: "gmail" },
          }),
        ),
    });
    const contribution = createComposioUserBackendContribution(
      backendHost(storage, (request) =>
        reconcileComposioProviderConnection(client, request),
      ),
    );
    await startInstalledConnection(contribution, {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
    });
    await contribution.recordConnectLinkResult("user-1", "connection-1", {
      connectedAccountId: "account-1",
      providerAlias: "connection-1",
      toolkitSlug: "gmail",
    });
    await contribution.finishConnectionAuthorization("user-1", "connection-1", {
      state: "ready",
    });
    await contribution.claimConnectionRevocation("user-1", "connection-1");
    await contribution.requireConnectionReconciliation(
      "user-1",
      "connection-1",
      "revoke",
      "Revocation outcome requires reconciliation",
    );
    await makeReconciliationDue(storage);

    await contribution.alarm();

    expect(
      await contribution.getConnection("user-1", "connection-1"),
    ).toMatchObject({ state: "reconciliation-required" });
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
  });
});
