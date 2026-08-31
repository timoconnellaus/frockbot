// Package-level setting values against the real User Durable Object.
//
// The claims, in order:
//
//  1. a `user/set-package-settings` command writes durable state the User
//     Durable Object owns, projected onto the installation row a client reads;
//  2. the values survive eviction, because they are durable state and not a
//     resident cache;
//  3. an uninstall drops them, and a reinstall starts from the Package's own
//     defaults rather than resurrecting configuration the User discarded;
//  4. a value the Package's declared schema refuses never reaches storage.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type {
  OperationReceiptV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";

const PACKAGE_ID = "provider-ollama-cloud";
const SETTING_ID = "web-search-max-results";

interface ConfigurationRpc {
  readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
  executeConfiguration(input: unknown): Promise<OperationReceiptV1>;
}

function userStub(userId: string): ConfigurationRpc {
  // SAFETY: the generated stub type for these two methods is too deep for the
  // compiler to instantiate here; this names the surface the test uses.
  return env.USER_CONFIGURATIONS.getByName(
    userId,
  ) as unknown as ConfigurationRpc;
}

async function read(userId: string): Promise<UserSettingsViewV1> {
  return userStub(userId).readConfiguration({ schemaVersion: 1, userId });
}

async function execute(
  userId: string,
  command: Record<string, unknown>,
): Promise<OperationReceiptV1> {
  return userStub(userId).executeConfiguration({
    schemaVersion: 1,
    userId,
    command,
  });
}

function installedValues(
  view: UserSettingsViewV1,
): Record<string, unknown> | undefined {
  return view.packages.find((pkg) => pkg.packageId === PACKAGE_ID)?.values;
}

async function installProvider(userId: string, attempt = 1): Promise<void> {
  await execute(userId, {
    schemaVersion: 1,
    type: "user/install-package",
    commandId: `install-${attempt}-${userId}`,
    expectedRevision: (await read(userId)).revision,
    packageId: PACKAGE_ID,
    version: "0.0.1",
  });
}

describe("Package setting values in the User Durable Object", () => {
  test("are durable across eviction, and an uninstall drops them", async () => {
    const userId = `package-settings-${crypto.randomUUID().slice(0, 8)}`;
    await installProvider(userId);

    await execute(userId, {
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: `set-${userId}`,
      expectedRevision: (await read(userId)).revision,
      packageId: PACKAGE_ID,
      values: { [SETTING_ID]: 2 },
    });
    expect(installedValues(await read(userId))).toEqual({ [SETTING_ID]: 2 });

    // THE VALUES ARE DURABLE. They outlive the object that admitted them.
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect(installedValues(await read(userId))).toEqual({ [SETTING_ID]: 2 });

    // A PARTIAL UPDATE SURVIVES THE SAME WAY, and replaces only what it names.
    await execute(userId, {
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: `set-again-${userId}`,
      expectedRevision: (await read(userId)).revision,
      packageId: PACKAGE_ID,
      values: { [SETTING_ID]: 7 },
    });
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect(installedValues(await read(userId))).toEqual({ [SETTING_ID]: 7 });

    // AN UNINSTALL DROPS THEM. The row is the store, so removing the row
    // removes the configuration with it.
    await execute(userId, {
      schemaVersion: 1,
      type: "user/uninstall-package",
      commandId: `uninstall-${userId}`,
      expectedRevision: (await read(userId)).revision,
      packageId: PACKAGE_ID,
    });
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    expect(
      (await read(userId)).packages.some((pkg) => pkg.packageId === PACKAGE_ID),
    ).toBe(false);

    // AND A REINSTALL STARTS CLEAN.
    await installProvider(userId, 2);
    expect(installedValues(await read(userId))).toBeUndefined();
  });

  test("a value the declared schema refuses never reaches storage", async () => {
    const userId = `package-settings-bad-${crypto.randomUUID().slice(0, 8)}`;
    await installProvider(userId);
    const revision = (await read(userId)).revision;

    await expect(
      execute(userId, {
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: `refused-${userId}`,
        expectedRevision: revision,
        packageId: PACKAGE_ID,
        values: { [SETTING_ID]: 99 },
      }),
    ).rejects.toThrow();

    const view = await read(userId);
    expect(installedValues(view)).toBeUndefined();
    // A refused command bumps nothing: the revision a client holds is still good.
    expect(view.revision).toBe(revision);
  });
});
