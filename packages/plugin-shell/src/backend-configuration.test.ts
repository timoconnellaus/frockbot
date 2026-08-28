import { describe, expect, test } from "bun:test";
import type {
  BotSettingsViewV1,
  ConfigurationCommandV1,
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

function assignmentCommand(
  commandId: string,
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  },
): ConfigurationCommandV1 {
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
  test("durably rejects invalid assignments before dependency claims", async () => {
    const storage = new MemoryStorage();
    let user = installedUser();
    let dependencyClaims = 0;
    let dependencyAcknowledgements = 0;
    let reads = 0;
    let claimAuthorized = true;
    const userConfiguration = {
      read: () => {
        reads += 1;
        return Promise.resolve(structuredClone(user));
      },
      claimConnectionDependency: (
        _userId: string,
        _connectionId: string,
        _botId: string,
        _generation: string,
        requirement: unknown,
      ) => {
        expect(requirement).toEqual({
          schemaVersion: 1,
          packageId: "composio",
          packageVersion: "0.0.1",
          capabilityId: "gmail-tools",
          connectionTypeIds: ["gmail"],
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
    });
    const identity = { userId: "user-1", botId: "primary" };

    const missingConnection = assignmentCommand("missing-connection", {
      packageId: "composio",
      capabilityId: "gmail-tools",
    });
    const first = await contribution.executeConfiguration(
      identity,
      missingConnection,
    );
    expect(first).toMatchObject({
      status: "rejected",
      revision: 0,
      failure: expect.stringContaining("requires a Connection"),
    });
    const readsAfterFirst = reads;
    expect(
      await contribution.executeConfiguration(identity, missingConnection),
    ).toEqual(first);
    expect(reads).toBe(readsAfterFirst);

    expect(
      await contribution.executeConfiguration(
        identity,
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
      await contribution.executeConfiguration(
        identity,
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
      await contribution.executeConfiguration(
        identity,
        assignmentCommand("disabled-package", {
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "rejected", revision: 0 });

    expect(dependencyClaims).toBe(0);
    expect(await contribution.getSettings(identity)).toMatchObject({
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
    const changedReceipt = await contribution.executeConfiguration(
      identity,
      changedDuringClaim,
    );
    expect(changedReceipt).toMatchObject({ status: "rejected", revision: 0 });
    expect(
      await contribution.executeConfiguration(identity, changedDuringClaim),
    ).toEqual(changedReceipt);
    expect(dependencyClaims).toBe(1);
    expect(dependencyAcknowledgements).toBe(0);
    expect(await contribution.getSettings(identity)).toMatchObject({
      revision: 0,
      assignments: [],
    });

    claimAuthorized = true;
    expect(
      await contribution.executeConfiguration(
        identity,
        assignmentCommand("valid-assignment", {
          packageId: "composio",
          capabilityId: "gmail-tools",
          connectionId: "gmail-1",
        }),
      ),
    ).toMatchObject({ status: "applied", revision: 1 });
    expect(dependencyClaims).toBe(2);
    expect(dependencyAcknowledgements).toBe(1);
    expect(await contribution.getSettings(identity)).toMatchObject({
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
});
