import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  createComposioUserBackendContribution,
  deriveRevocationCompensations,
} from "./user-configuration.js";

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
  test("atomically enforces the Package and Connection Type requirement", async () => {
    const storage = new MemoryStorage();
    const contribution = createComposioUserBackendContribution({
      state: { storage } as unknown as DurableObjectState,
      env: {} as never,
    });
    await contribution.execute("user-1", {
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
    const beforeClaim = await contribution.read("user-1");
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
    expect(
      (await contribution.read("user-1")).connections[0]?.safeMetadata,
    ).toMatchObject({
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
