import { describe, expect, test } from "bun:test";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import type {
  BotConfigurationCommandV1,
  BotSettingsViewV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
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

function installedUser(): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    profile: { name: "User" },
    packages: [{ packageId: "composio", version: "0.0.1", state: "installed" }],
    connections: [
      {
        connectionId: "gmail-1",
        packageId: "composio",
        connectionTypeId: "gmail",
        displayName: "Gmail",
        state: "ready",
        safeMetadata: {},
      },
    ],
  };
}

async function compileAssignmentTestApplication(): ReturnType<
  typeof compileFoundationApplication
> {
  const application = await compileFoundationApplication();
  const template = application.packages.find((pkg) => pkg.id === "settings");
  if (!template) throw new Error("Settings fixture Package is unavailable");
  return {
    ...application,
    packages: [
      ...application.packages,
      {
        ...template,
        id: "composio",
        specifier: "@test/composio",
        version: "0.0.1",
        manifest: {
          ...template.manifest,
          id: "composio",
          displayName: "Connection fixture",
          version: "0.0.1",
          dependencies: {},
          contributions: {},
          permissions: [],
          configuration: {
            settings: [],
            connectionTypes: [
              {
                id: "gmail",
                displayName: "Gmail",
                allowMultiple: true,
                authorization: { kind: "grant", driverId: "fixture" },
                capabilities: ["gmail-tools"],
              },
            ],
            capabilities: [
              {
                id: "gmail-tools",
                kind: "tool",
                connectionTypes: ["gmail"],
              },
            ],
          },
        },
      },
    ],
  };
}

function assignmentCommand(
  commandId: string,
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  },
): BotConfigurationCommandV1 {
  return {
    schemaVersion: 1,
    type: "bot/assign-capability",
    commandId,
    botId: "primary",
    expectedRevision: 0,
    assignment: {
      assignmentId: commandId,
      ...assignment,
    },
  };
}

describe("Bot capability assignment admission", () => {
  test("rejects an unmaterialized Bot without writing durable state", async () => {
    const storage = new MemoryStorage();
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await expect(
      contribution.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "unknown",
      }),
    ).rejects.toThrow("not materialized");
    expect(storage.values.size).toBe(0);
  });

  test("validates notification authority without changing settings", async () => {
    const storage = new MemoryStorage();
    const settings = {
      schemaVersion: 1,
      botId: "primary",
      revision: 7,
      profile: { name: "Primary" },
      notifications: { enabled: true },
      assignments: [],
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
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => ({
            readConfiguration: () =>
              Promise.resolve({
                ...installedUser(),
                newBotModelTemplate: {
                  connectionId: "provider-1",
                  providerModelId: "model-1",
                },
              }),
          }),
        },
      } as never,
    });

    await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      {
        name: "Primary",
        model: { connectionId: "provider-1", providerModelId: "model-1" },
      },
    );
    await expect(
      contribution.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "primary",
      }),
    ).resolves.toMatchObject({
      model: {
        connectionId: "provider-1",
        providerModelId: "model-1",
      },
    });
  });

  test("binds in-flight and durable receipts to the complete Bot command", async () => {
    const storage = new MemoryStorage();
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(installedUser()),
    };
    const host = {
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => userConfiguration,
        },
      } as never,
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
    const request = (command: BotConfigurationCommandV1) => ({
      schemaVersion: 1 as const,
      userId: "user-1",
      botId: "primary",
      command,
    });
    const contribution = createShellBotBackendContribution(host);
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

    const redeployed = createShellBotBackendContribution(host);
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

  test("durably rejects invalid assignments before dependency claims", async () => {
    const storage = new MemoryStorage();
    let user = installedUser();
    let dependencyClaims = 0;
    let dependencyAcknowledgements = 0;
    let reads = 0;
    let claimAuthorized = true;
    const userConfiguration = {
      readConfiguration: () => {
        reads += 1;
        return Promise.resolve(structuredClone(user));
      },
      claimConnectionDependency: (request: unknown) => {
        expect(request).toEqual({
          schemaVersion: 1,
          userId: "user-1",
          connectionId: "gmail-1",
          botId: "primary",
          generation: expect.any(String),
          requirement: {
            schemaVersion: 1,
            packageId: "composio",
            packageVersion: "0.0.1",
            capabilityId: "gmail-tools",
            connectionTypeIds: ["gmail"],
          },
        });
        dependencyClaims += 1;
        return Promise.resolve(claimAuthorized);
      },
      acknowledgeConnectionDependency: () => {
        dependencyAcknowledgements += 1;
        return Promise.resolve(true);
      },
      compensateConnectionDependency: () => Promise.resolve(true),
    };
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => userConfiguration,
        },
      } as never,
      compileApplication: compileAssignmentTestApplication,
    });
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });
    const execute = (command: BotConfigurationCommandV1) =>
      contribution.executeConfiguration({
        schemaVersion: 1,
        ...identity,
        command,
      });
    const read = () =>
      contribution.readConfiguration({ schemaVersion: 1, ...identity });

    await expect(
      contribution.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "../primary",
      }),
    ).rejects.toThrow("botId is invalid");
    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "malformed-profile",
          botId: "primary",
          expectedRevision: 0,
          profile: { name: 42 },
        },
      }),
    ).rejects.toThrow("profile.name must be a string");
    expect(await read()).toMatchObject({ revision: 0, assignments: [] });

    const missingConnection = assignmentCommand("missing-connection", {
      packageId: "composio",
      capabilityId: "gmail-tools",
    });
    const first = await execute(missingConnection);
    expect(first).toMatchObject({
      status: "rejected",
      revision: 0,
      failure: expect.stringContaining("requires a Connection"),
    });
    const readsAfterFirst = reads;
    expect(await execute(missingConnection)).toEqual(first);
    expect(reads).toBe(readsAfterFirst);

    expect(
      await execute(
        assignmentCommand("unknown-capability", {
          packageId: "composio",
          capabilityId: "unknown",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "rejected", revision: 0 });

    user = {
      ...installedUser(),
      connections: [
        { ...installedUser().connections[0]!, connectionTypeId: "calendar" },
      ],
    };
    expect(
      await execute(
        assignmentCommand("wrong-connection-type", {
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "rejected", revision: 0 });

    user = {
      ...installedUser(),
      packages: [{ ...installedUser().packages[0]!, state: "disabled" }],
    };
    expect(
      await execute(
        assignmentCommand("disabled-package", {
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "rejected", revision: 0 });

    expect(dependencyClaims).toBe(0);
    expect(await read()).toMatchObject({
      revision: 0,
      assignments: [],
    } satisfies Partial<BotSettingsViewV1>);

    user = installedUser();
    claimAuthorized = false;
    const changedDuringClaim = assignmentCommand("changed-during-claim", {
      packageId: "composio",
      capabilityId: "gmail-tools",
      connectionId: "gmail-1",
    });
    const changedReceipt = await execute(changedDuringClaim);
    expect(changedReceipt).toMatchObject({ status: "rejected", revision: 0 });
    expect(await execute(changedDuringClaim)).toEqual(changedReceipt);
    expect(dependencyClaims).toBe(1);
    expect(dependencyAcknowledgements).toBe(0);
    expect(await read()).toMatchObject({
      revision: 0,
      assignments: [],
    });

    claimAuthorized = true;
    expect(
      await execute(
        assignmentCommand("valid-assignment", {
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "applied", revision: 1 });
    expect(dependencyClaims).toBe(2);
    expect(dependencyAcknowledgements).toBe(1);
    expect(await read()).toMatchObject({
      revision: 1,
      assignments: [
        {
          assignmentId: "valid-assignment",
          state: "enabled",
          connectionId: "gmail-1",
        },
      ],
    });
  });

  test("settles a committed assignment saga before replaying its receipt", async () => {
    const storage = new MemoryStorage();
    let acknowledgementAttempts = 0;
    let acknowledged = false;
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(installedUser()),
      claimConnectionDependency: () => Promise.resolve(true),
      acknowledgeConnectionDependency: () => {
        acknowledgementAttempts += 1;
        if (acknowledgementAttempts <= 2) {
          return Promise.reject(new Error("acknowledgement response lost"));
        }
        acknowledged = true;
        return Promise.resolve(true);
      },
      compensateConnectionDependency: () => Promise.resolve(true),
    };
    const contribution = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => userConfiguration,
        },
      } as never,
      compileApplication: compileAssignmentTestApplication,
    });
    await contribution.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Primary" },
    );
    const command = assignmentCommand("lost-assignment-response", {
      packageId: "composio",
      capabilityId: "gmail-tools",
      connectionId: "gmail-1",
    });
    const execute = () =>
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: "user-1",
        botId: "primary",
        command,
      });

    await expect(execute()).rejects.toThrow(
      "Connection assignment admission and reconciliation failed",
    );
    expect(acknowledgementAttempts).toBe(2);
    expect(acknowledged).toBe(false);

    await expect(execute()).resolves.toMatchObject({
      commandId: "lost-assignment-response",
      status: "applied",
      revision: 1,
    });
    expect(acknowledgementAttempts).toBe(3);
    expect(acknowledged).toBe(true);
  });
});
