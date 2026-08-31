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
        providerType: "fixture-models",
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
                capabilities: ["gmail-tools", "gmail-send"],
              },
            ],
            capabilities: [
              {
                id: "gmail-tools",
                kind: "model",
                connectionTypes: ["gmail"],
              },
              {
                id: "gmail-send",
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
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        command: {
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "archived-profile",
          botId: identity.botId,
          expectedRevision: 0,
          profile: { name: "Changed" },
        },
      }),
    ).rejects.toThrow("archived");
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 0,
      profile: { name: "Primary" },
    });
  });

  test("rechecks lifecycle admission in the configuration mutation transaction", async () => {
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
    const identity = { userId: "user-1", botId: "primary" };
    await contribution.materializeSettings(identity, { name: "Primary" });
    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        command: {
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "racing-profile",
          botId: identity.botId,
          expectedRevision: 0,
          profile: { name: "Changed" },
        },
      }),
    ).rejects.toThrow("archived");
    expect(await contribution.getSettings(identity)).toMatchObject({
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
      assignments: [],
      assignmentOperations: [],
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
    const dependencyStates = new Map<string, "claimed" | "acknowledged">();
    const userConfiguration = {
      readConfiguration: () => {
        reads += 1;
        return Promise.resolve(structuredClone(user));
      },
      executeConnectionDependency: (request: {
        action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
        operationId: string;
        requirement?: unknown;
      }) => {
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status:
              dependencyStates.get(request.operationId) ?? ("absent" as const),
          });
        }
        if (request.action === "claim") {
          expect(request.requirement).toEqual({
            schemaVersion: 1,
            packageId: "composio",
            packageVersion: "0.0.1",
            capabilityId: "gmail-tools",
            connectionTypeIds: ["gmail"],
          });
          dependencyClaims += 1;
          if (claimAuthorized) {
            dependencyStates.set(request.operationId, "claimed");
          }
          return Promise.resolve(
            claimAuthorized
              ? { schemaVersion: 1 as const, status: "claimed" as const }
              : {
                  schemaVersion: 1 as const,
                  status: "rejected" as const,
                  failure: "claim rejected",
                },
          );
        }
        if (request.action === "acknowledge") {
          dependencyAcknowledgements += 1;
          dependencyStates.set(request.operationId, "acknowledged");
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "released" as const,
        });
      },
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

    await expect(
      execute({
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: "reuse-assignment-authority",
        botId: "primary",
        expectedRevision: 1,
        assignment: {
          assignmentId: "valid-assignment",
          packageId: "composio",
          capabilityId: "gmail-send",
          connectionId: "gmail-1",
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      revision: 1,
      failure: "Assignment ID cannot change Package Capability authority",
    });
    expect(dependencyClaims).toBe(2);
  });

  test("atomically binds and durably unbinds a Connection model", async () => {
    const storage = new MemoryStorage();
    let dependencyGeneration: string | undefined;
    let releaseAttempts = 0;
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(installedUser()),
      executeConnectionDependency: (request: {
        action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
        generation: string;
      }) => {
        if (request.action === "claim") {
          dependencyGeneration = request.generation;
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "claimed" as const,
          });
        }
        if (request.action === "acknowledge") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status:
              request.generation === dependencyGeneration
                ? ("acknowledged" as const)
                : ("absent" as const),
          });
        }
        if (request.action === "release") {
          releaseAttempts += 1;
          if (releaseAttempts === 1) {
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "pending" as const,
            });
          }
          if (request.generation === dependencyGeneration) {
            dependencyGeneration = undefined;
          }
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "released" as const,
          });
        }
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "released" as const,
        });
      },
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

    const bound = await execute({
      schemaVersion: 1,
      type: "bot/assign-capability",
      commandId: "bind-model",
      botId: "primary",
      expectedRevision: 0,
      assignment: {
        assignmentId: "fixture-model",
        packageId: "composio",
        capabilityId: "gmail-tools",
        connectionId: "gmail-1",
      },
      model: {
        connectionId: "gmail-1",
        providerModelId: "fixture-model:latest",
      },
    });

    expect(bound).toMatchObject({ status: "applied", revision: 1 });
    expect(dependencyGeneration).toBe("bind-model");
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 1,
      model: {
        connectionId: "gmail-1",
        providerModelId: "fixture-model:latest",
      },
      assignments: [{ assignmentId: "fixture-model", state: "enabled" }],
    });

    const unavailable = await contribution.getSettings(identity);
    await storage.put("bot-configuration", {
      ...unavailable,
      assignments: unavailable.assignments.map((assignment) => ({
        ...assignment,
        state: "unavailable" as const,
      })),
    });

    const unbind: BotConfigurationCommandV1 = {
      schemaVersion: 1,
      type: "bot/unbind-model",
      commandId: "unbind-model",
      botId: "primary",
      expectedRevision: 1,
      assignmentId: "fixture-model",
    };
    // The release is delayed once: the Unassign stays visibly retrying and its
    // durable receipt replays until the dependency is actually released.
    await expect(execute(unbind)).resolves.toMatchObject({
      status: "pending",
    });
    expect(dependencyGeneration).toBe("bind-model");
    await contribution.alarm();

    const unbound = await execute(unbind);

    expect(unbound).toMatchObject({ status: "applied", revision: 2 });
    expect(releaseAttempts).toBe(2);
    expect(dependencyGeneration).toBeUndefined();
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 2,
      model: undefined,
      assignments: [],
    });
  });

  test("releases the superseded model dependency after switching Connections", async () => {
    const storage = new MemoryStorage();
    const user = installedUser();
    user.connections.push({
      ...user.connections[0]!,
      connectionId: "gmail-2",
      displayName: "Gmail 2",
    });
    const generations = new Set<string>();
    const released: Array<{ connectionId: string; generation: string }> = [];
    let releaseAttempts = 0;
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(user),
      executeConnectionDependency: (request: {
        action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
        connectionId: string;
        generation: string;
      }) => {
        if (request.action === "claim") {
          generations.add(request.generation);
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "claimed" as const,
          });
        }
        if (request.action === "acknowledge") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: generations.has(request.generation)
              ? ("acknowledged" as const)
              : ("absent" as const),
          });
        }
        if (request.action === "release") {
          releaseAttempts += 1;
          if (releaseAttempts === 1) {
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "pending" as const,
            });
          }
          released.push({
            connectionId: request.connectionId,
            generation: request.generation,
          });
          generations.delete(request.generation);
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "released" as const,
          });
        }
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "released" as const,
        });
      },
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

    await execute({
      schemaVersion: 1,
      type: "bot/assign-capability",
      commandId: "bind-gmail-1",
      botId: "primary",
      expectedRevision: 0,
      assignment: {
        assignmentId: "gmail-model-1",
        packageId: "composio",
        capabilityId: "gmail-tools",
        connectionId: "gmail-1",
      },
      model: {
        connectionId: "gmail-1",
        providerModelId: "fixture-model:latest",
      },
    });
    const beforeSwitch = await contribution.getSettings(identity);
    await storage.put({
      "bot-configuration": {
        ...beforeSwitch,
        assignments: [
          ...beforeSwitch.assignments,
          {
            assignmentId: "gmail-tool",
            packageId: "composio",
            capabilityId: "gmail-send",
            connectionId: "gmail-1",
            state: "enabled" as const,
          },
        ],
      },
      "assignment-generation:gmail-tool": "tool-generation",
    });
    generations.add("tool-generation");

    // Moving the model to another Connection is an atomic Replace on the same
    // Assignment: it claims the new dependency, commits the swap, then
    // releases the old one. A delayed release stays visibly retrying rather
    // than failing the command.
    const switchModel: BotConfigurationCommandV1 = {
      schemaVersion: 1,
      type: "bot/replace-capability",
      commandId: "bind-gmail-2",
      botId: "primary",
      expectedRevision: 1,
      assignment: {
        assignmentId: "gmail-model-1",
        packageId: "composio",
        capabilityId: "gmail-tools",
        connectionId: "gmail-2",
      },
      model: {
        connectionId: "gmail-2",
        providerModelId: "fixture-model:latest",
      },
    };
    await expect(execute(switchModel)).resolves.toMatchObject({
      status: "applied",
      revision: 2,
    });
    // The commit is durable; only the old release is still retrying.
    await contribution.alarm();
    await expect(execute(switchModel)).resolves.toMatchObject({
      status: "applied",
      revision: 2,
    });

    expect(releaseAttempts).toBe(2);
    expect(released).toEqual([
      { connectionId: "gmail-1", generation: "bind-gmail-1" },
    ]);
    expect(generations.has("bind-gmail-1")).toBe(false);
    expect(generations.has("tool-generation")).toBe(true);
    expect(generations.has("bind-gmail-2")).toBe(true);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 2,
      model: { connectionId: "gmail-2" },
      assignments: [
        { assignmentId: "gmail-tool", state: "enabled" },
        { assignmentId: "gmail-model-1", state: "enabled" },
      ],
    });

    // Each further move is another Replace on the same Assignment, so each
    // one releases exactly the Connection it superseded.
    for (const [commandId, connectionId, expectedRevision] of [
      ["bind-gmail-1-again", "gmail-1", 2],
      ["bind-gmail-2-again", "gmail-2", 3],
    ] as const) {
      await expect(
        execute({
          schemaVersion: 1,
          type: "bot/replace-capability",
          commandId,
          botId: "primary",
          expectedRevision,
          assignment: {
            assignmentId: "gmail-model-1",
            packageId: "composio",
            capabilityId: "gmail-tools",
            connectionId,
          },
          model: {
            connectionId,
            providerModelId: "fixture-model:latest",
          },
        }),
      ).resolves.toMatchObject({
        status: "applied",
        revision: expectedRevision + 1,
      });
    }

    expect(released.slice(-2)).toEqual([
      { connectionId: "gmail-2", generation: "bind-gmail-2" },
      { connectionId: "gmail-1", generation: "bind-gmail-1-again" },
    ]);
    expect(generations.has("bind-gmail-1")).toBe(false);
    expect(generations.has("bind-gmail-2")).toBe(false);
    expect(generations.has("bind-gmail-1-again")).toBe(false);
    expect(generations.has("tool-generation")).toBe(true);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 4,
      model: { connectionId: "gmail-2" },
      assignments: [
        { assignmentId: "gmail-tool", state: "enabled" },
        { assignmentId: "gmail-model-1", state: "enabled" },
      ],
    });
  });

  test("orders atomic Replace and keeps Unassign stable until release", async () => {
    const storage = new MemoryStorage();
    const user = installedUser();
    user.connections.push({
      ...user.connections[0]!,
      connectionId: "gmail-2",
      displayName: "Gmail replacement",
    });
    const dependencies = new Map<
      string,
      "claimed" | "acknowledged" | "released"
    >();
    const log: string[] = [];
    let holdRelease = false;
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(structuredClone(user)),
      executeConnectionDependency: (request: {
        action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
        generation: string;
      }) => {
        log.push(`${request.action}:${request.generation}`);
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: dependencies.get(request.generation) ?? ("absent" as const),
          });
        }
        if (request.action === "claim") {
          dependencies.set(request.generation, "claimed");
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "claimed" as const,
          });
        }
        if (request.action === "acknowledge") {
          dependencies.set(request.generation, "acknowledged");
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        if (request.action === "release" && holdRelease) {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "pending" as const,
          });
        }
        if (request.action === "release")
          dependencies.set(request.generation, "released");
        return Promise.resolve({
          schemaVersion: 1 as const,
          status:
            request.action === "reconcile"
              ? ("pending" as const)
              : ("released" as const),
        });
      },
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

    await expect(
      execute({
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: "assign-1",
        botId: "primary",
        expectedRevision: 0,
        assignment: {
          assignmentId: "mail",
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });
    log.length = 0;

    await expect(
      execute({
        schemaVersion: 1,
        type: "bot/replace-capability",
        commandId: "replace-1",
        botId: "primary",
        expectedRevision: 1,
        assignment: {
          assignmentId: "mail",
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-2",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 2 });
    expect(log).toEqual([
      "read:replace-1",
      "claim:replace-1",
      "read:replace-1",
      "acknowledge:replace-1",
      "read:assign-1",
      "release:assign-1",
    ]);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 2,
      assignments: [{ assignmentId: "mail", connectionId: "gmail-2" }],
      assignmentOperations: [],
    });

    holdRelease = true;
    const pendingUnassign = await execute({
      schemaVersion: 1,
      type: "bot/unassign-capability",
      commandId: "unassign-1",
      botId: "primary",
      expectedRevision: 2,
      assignmentId: "mail",
    });
    expect(pendingUnassign).toEqual({
      schemaVersion: 1,
      commandId: "unassign-1",
      revision: 2,
      status: "pending",
    });
    await expect(
      execute({
        schemaVersion: 1,
        type: "bot/unassign-capability",
        commandId: "unassign-1",
        botId: "primary",
        expectedRevision: 2,
        assignmentId: "mail",
      }),
    ).resolves.toEqual(pendingUnassign);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 2,
      assignments: [{ assignmentId: "mail", connectionId: "gmail-2" }],
      assignmentOperations: [
        { commandId: "unassign-1", kind: "unassigning", state: "retrying" },
      ],
    });

    holdRelease = false;
    const reconstructed = createShellBotBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => userConfiguration,
        },
      } as never,
      compileApplication: compileAssignmentTestApplication,
    });
    await reconstructed.alarm();
    expect(await reconstructed.getSettings(identity)).toMatchObject({
      revision: 3,
      assignments: [],
      assignmentOperations: [],
    });
    await expect(
      reconstructed.executeConfiguration({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          type: "bot/unassign-capability",
          commandId: "unassign-1",
          botId: "primary",
          expectedRevision: 2,
          assignmentId: "mail",
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 3 });
    await expect(
      reconstructed.executeConfiguration({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          type: "bot/unassign-capability",
          commandId: "unassign-1",
          botId: "primary",
          expectedRevision: 2,
          assignmentId: "other",
        },
      }),
    ).rejects.toThrow("reused for a different command");
  });

  test("releases the old Replace dependency when new acknowledgement is absent or rejected", async () => {
    for (const acknowledgement of ["absent", "rejected"] as const) {
      const storage = new MemoryStorage();
      const user = installedUser();
      user.connections.push({
        ...user.connections[0]!,
        connectionId: "gmail-2",
        displayName: "Gmail replacement",
      });
      const dependencies = new Map<
        string,
        "claimed" | "acknowledged" | "released"
      >();
      const log: string[] = [];
      let replacementReads = 0;
      let holdOldRelease = true;
      const userConfiguration = {
        readConfiguration: () => Promise.resolve(structuredClone(user)),
        executeConnectionDependency: (request: {
          action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
          generation: string;
        }) => {
          log.push(`${request.action}:${request.generation}`);
          if (request.action === "read") {
            if (request.generation.startsWith("replace-")) {
              replacementReads += 1;
              if (replacementReads > 1 && acknowledgement === "absent") {
                return Promise.resolve({
                  schemaVersion: 1 as const,
                  status: "absent" as const,
                });
              }
            }
            return Promise.resolve({
              schemaVersion: 1 as const,
              status:
                dependencies.get(request.generation) ?? ("absent" as const),
            });
          }
          if (request.action === "claim") {
            dependencies.set(request.generation, "claimed");
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "claimed" as const,
            });
          }
          if (request.action === "acknowledge") {
            if (
              request.generation.startsWith("replace-") &&
              acknowledgement === "rejected"
            ) {
              return Promise.resolve({
                schemaVersion: 1 as const,
                status: "rejected" as const,
                failure: "acknowledgement rejected",
              });
            }
            dependencies.set(request.generation, "acknowledged");
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "acknowledged" as const,
            });
          }
          if (request.action === "release") {
            if (request.generation === "assign-old" && holdOldRelease) {
              return Promise.resolve({
                schemaVersion: 1 as const,
                status: "pending" as const,
              });
            }
            dependencies.set(request.generation, "released");
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "released" as const,
            });
          }
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "pending" as const,
          });
        },
      };
      const makeContribution = () =>
        createShellBotBackendContribution({
          state: { storage } as unknown as DurableObjectState,
          env: {
            USER_CONFIGURATIONS: {
              idFromName: () => "user-1",
              get: () => userConfiguration,
            },
          } as never,
          compileApplication: compileAssignmentTestApplication,
        });
      const contribution = makeContribution();
      const identity = { userId: "user-1", botId: "primary" };
      await contribution.materializeSettings(identity, { name: "Primary" });
      const execute = (
        backend: ReturnType<typeof createShellBotBackendContribution>,
        command: BotConfigurationCommandV1,
      ) =>
        backend.executeConfiguration({
          schemaVersion: 1,
          ...identity,
          command,
        });
      await execute(contribution, {
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: "assign-old",
        botId: "primary",
        expectedRevision: 0,
        assignment: {
          assignmentId: "mail",
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        },
      });
      const replaceCommand = {
        schemaVersion: 1 as const,
        type: "bot/replace-capability" as const,
        commandId: `replace-${acknowledgement}`,
        botId: "primary",
        expectedRevision: 1,
        assignment: {
          assignmentId: "mail",
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-2",
        },
      };

      await expect(
        execute(contribution, replaceCommand),
      ).resolves.toMatchObject({ status: "applied", revision: 2 });
      expect(dependencies.get("assign-old")).toBe("acknowledged");
      expect(await contribution.getSettings(identity)).toMatchObject({
        revision: 2,
        assignments: [
          {
            assignmentId: "mail",
            connectionId: "gmail-2",
            state: "unavailable",
          },
        ],
        assignmentOperations: [
          {
            commandId: `replace-${acknowledgement}`,
            kind: "replacing",
            state: "retrying",
          },
        ],
      });
      expect(log).toContain("release:assign-old");

      holdOldRelease = false;
      const reconstructed = makeContribution();
      await reconstructed.alarm();
      expect(dependencies.get("assign-old")).toBe("released");
      expect(await reconstructed.getSettings(identity)).toMatchObject({
        revision: 2,
        assignments: [
          {
            assignmentId: "mail",
            connectionId: "gmail-2",
            state: "unavailable",
          },
        ],
        assignmentOperations: [],
      });
      await expect(
        execute(reconstructed, replaceCommand),
      ).resolves.toMatchObject({ status: "applied", revision: 2 });
    }
  });

  test("keeps provider absence retrying until the owner becomes available", async () => {
    const storage = new MemoryStorage();
    let available = false;
    let dependency: "absent" | "claimed" | "acknowledged" = "absent";
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(installedUser()),
      executeConnectionDependency: (request: { action: string }) => {
        if (!available) {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "unavailable" as const,
            failure: "Connection owner is unavailable",
          });
        }
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: dependency,
          });
        }
        if (request.action === "claim") dependency = "claimed";
        if (request.action === "acknowledge") dependency = "acknowledged";
        return Promise.resolve({
          schemaVersion: 1 as const,
          status:
            request.action === "claim"
              ? ("claimed" as const)
              : request.action === "acknowledge"
                ? ("acknowledged" as const)
                : ("pending" as const),
        });
      },
    };
    const host = {
      state: { storage } as unknown as DurableObjectState,
      env: {
        USER_CONFIGURATIONS: {
          idFromName: () => "user-1",
          get: () => userConfiguration,
        },
      } as never,
      compileApplication: compileAssignmentTestApplication,
    };
    const identity = { userId: "user-1", botId: "primary" };
    const contribution = createShellBotBackendContribution(host);
    await contribution.materializeSettings(identity, { name: "Primary" });
    const command = assignmentCommand("owner-retry", {
      packageId: "composio",
      capabilityId: "gmail-tools",
      connectionId: "gmail-1",
    });
    await expect(
      contribution.executeConfiguration({
        schemaVersion: 1,
        ...identity,
        command,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      commandId: "owner-retry",
      revision: 0,
      status: "pending",
    });
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 0,
      assignments: [],
      assignmentOperations: [{ commandId: "owner-retry", state: "retrying" }],
    });
    available = true;
    const reconstructed = createShellBotBackendContribution(host);
    await reconstructed.alarm();
    expect(await reconstructed.getSettings(identity)).toMatchObject({
      revision: 1,
      assignments: [{ assignmentId: "owner-retry", state: "enabled" }],
      assignmentOperations: [],
    });
  });

  test("scopes generations to Assignments that share one Connection", async () => {
    const storage = new MemoryStorage();
    const user = installedUser();
    user.connections.push({
      ...user.connections[0]!,
      connectionId: "gmail-2",
      displayName: "Gmail replacement",
    });
    const dependencies = new Map<
      string,
      "claimed" | "acknowledged" | "released"
    >();
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(structuredClone(user)),
      executeConnectionDependency: (request: {
        action: "claim" | "read" | "acknowledge" | "release" | "reconcile";
        generation: string;
      }) => {
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: dependencies.get(request.generation) ?? ("absent" as const),
          });
        }
        if (request.action === "claim") {
          dependencies.set(request.generation, "claimed");
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "claimed" as const,
          });
        }
        if (request.action === "acknowledge") {
          dependencies.set(request.generation, "acknowledged");
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        if (request.action === "release") {
          dependencies.set(request.generation, "released");
        }
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "released" as const,
        });
      },
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
    const assign = (
      commandId: string,
      expectedRevision: number,
      assignmentId: string,
      connectionId: string,
      type:
        | "bot/assign-capability"
        | "bot/replace-capability" = "bot/assign-capability",
    ) =>
      execute({
        schemaVersion: 1,
        type,
        commandId,
        botId: "primary",
        expectedRevision,
        assignment: {
          assignmentId,
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId,
        },
      });

    await assign("assign-a", 0, "mail-a", "gmail-1");
    await assign("assign-b", 1, "mail-b", "gmail-1");
    await assign("replace-a", 2, "mail-a", "gmail-2", "bot/replace-capability");
    expect(dependencies.get("assign-a")).toBe("released");
    expect(dependencies.get("assign-b")).toBe("acknowledged");
    await execute({
      schemaVersion: 1,
      type: "bot/unassign-capability",
      commandId: "unassign-a",
      botId: "primary",
      expectedRevision: 3,
      assignmentId: "mail-a",
    });
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 4,
      assignments: [
        {
          assignmentId: "mail-b",
          connectionId: "gmail-1",
          state: "enabled",
        },
      ],
    });
    expect(dependencies.get("assign-b")).toBe("acknowledged");
  });

  test("settles a committed assignment saga before replaying its receipt", async () => {
    const storage = new MemoryStorage();
    let acknowledgementAttempts = 0;
    let acknowledged = false;
    let dependencyStatus: "absent" | "claimed" | "acknowledged" = "absent";
    const userConfiguration = {
      readConfiguration: () => Promise.resolve(installedUser()),
      executeConnectionDependency: (request: { action: string }) => {
        if (request.action === "read") {
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: dependencyStatus,
          });
        }
        if (request.action === "claim") {
          dependencyStatus = "claimed";
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "claimed" as const,
          });
        }
        if (request.action === "acknowledge") {
          acknowledgementAttempts += 1;
          if (acknowledgementAttempts <= 1) {
            return Promise.reject(new Error("acknowledgement response lost"));
          }
          dependencyStatus = "acknowledged";
          acknowledged = true;
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "acknowledged" as const,
          });
        }
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "released" as const,
        });
      },
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

    await expect(execute()).resolves.toEqual({
      schemaVersion: 1,
      commandId: "lost-assignment-response",
      status: "pending",
      revision: 0,
    });
    expect(acknowledgementAttempts).toBe(1);
    expect(acknowledged).toBe(false);

    await expect(execute()).resolves.toMatchObject({
      commandId: "lost-assignment-response",
      status: "applied",
      revision: 1,
    });
    expect(acknowledgementAttempts).toBe(2);
    expect(acknowledged).toBe(true);
  });
});
