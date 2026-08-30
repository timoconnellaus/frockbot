import { describe, expect, test } from "bun:test";
import { ConnectionDependencyRouter } from "@frockbot/connection-core";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import { executeUserConnectionDependency } from "./connection-dependency-router.js";

const settings: UserSettingsViewV1 = {
  schemaVersion: 1,
  revision: 0,
  profile: { name: "User" },
  packages: [{ packageId: "mail", version: "1.0.0", state: "installed" }],
  connections: [
    {
      connectionId: "mail-1",
      packageId: "mail",
      connectionTypeId: "oauth",
      displayName: "Mail",
      state: "ready",
      safeMetadata: {},
    },
  ],
};

const read = {
  schemaVersion: 1,
  action: "read",
  operationId: "operation-1",
  userId: "user-1",
  packageId: "mail",
  connectionId: "mail-1",
  botId: "bot-1",
  generation: "generation-1",
} as const;

describe("User Connection dependency routing", () => {
  test("selects the owner from durable Connection Package identity", async () => {
    const router = new ConnectionDependencyRouter();
    const calls: unknown[] = [];
    router.register({
      packageId: "mail",
      executeDependency: (command) => {
        calls.push(command);
        return Promise.resolve({ schemaVersion: 1, status: "acknowledged" });
      },
    });
    await expect(
      executeUserConnectionDependency(settings, router, read),
    ).resolves.toMatchObject({ status: "acknowledged" });
    expect(calls).toEqual([read]);
  });

  test("cannot fabricate availability for an absent owner", async () => {
    await expect(
      executeUserConnectionDependency(
        settings,
        new ConnectionDependencyRouter(),
        read,
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      failure: expect.stringContaining("no backend Contribution"),
    });
  });

  test("routes recovery to the known owner even when the Connection is not ready", async () => {
    const router = new ConnectionDependencyRouter();
    const actions: string[] = [];
    router.register({
      packageId: "mail",
      executeDependency: (command) => {
        actions.push(command.action);
        return Promise.resolve({ schemaVersion: 1, status: "released" });
      },
    });
    const nonReady = {
      ...settings,
      connections: [{ ...settings.connections[0]!, state: "failed" as const }],
    };
    await expect(
      executeUserConnectionDependency(nonReady, router, {
        ...read,
        action: "release",
      }),
    ).resolves.toMatchObject({ status: "released" });
    await expect(
      executeUserConnectionDependency(
        { ...settings, connections: [] },
        router,
        { ...read, action: "reconcile" },
      ),
    ).resolves.toMatchObject({ status: "released" });
    expect(actions).toEqual(["release", "reconcile"]);
  });

  test("keeps a claim retryable while its Connection is unavailable", async () => {
    const router = new ConnectionDependencyRouter();
    const claim = {
      ...read,
      action: "claim" as const,
      requirement: {
        schemaVersion: 1 as const,
        packageId: "mail",
        packageVersion: "1.0.0",
        capabilityId: "send",
        connectionTypeIds: ["oauth"],
      },
    };
    await expect(
      executeUserConnectionDependency(
        {
          ...settings,
          connections: [
            { ...settings.connections[0]!, state: "authorizing" as const },
          ],
        },
        router,
        claim,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
