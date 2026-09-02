// Seam S3: the gateway's settings routes, which it answers itself out of the
// User and Bot Durable Objects before the Worker Loader is ever consulted.
import { describe, expect, it } from "vitest";
import {
  asUser,
  CUSTOM_MODELS_PACKAGE_ID,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  PROVISIONED_MODEL,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("settings round-trip through the gateway", () => {
  it("carries the account-model choice from the Package setting to the User view", async () => {
    const userId = freshUserId("settings-model");
    const botId = "settings-bot";
    // `provisionThroughGateway` is itself the command half: it writes the
    // Custom models Package's account-scoped `model` setting.
    const { connectionId } = await provisionThroughGateway({ userId, botId });

    const view = (await expectOkJson(
      await asUser(userId, "/api/settings"),
    )) as {
      packages: Array<{
        packageId: string;
        state: string;
        values?: Record<string, unknown>;
      }>;
    };
    expect(
      view.packages.find((pkg) => pkg.packageId === CUSTOM_MODELS_PACKAGE_ID)
        ?.values,
    ).toMatchObject({
      model: {
        connectionId,
        providerModelId: PROVISIONED_MODEL.providerModelId,
      },
    });
    expect(view.packages).toContainEqual(
      expect.objectContaining({
        packageId: PROVISIONED_MODEL.packageId,
        state: "installed",
      }),
    );
  });

  it("carries a Bot profile change from the command to the Bot view", async () => {
    const userId = freshUserId("settings-bot-view");
    const botId = "profile-bot";
    await provisionThroughGateway({ userId, botId });

    const before = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/settings`),
    )) as { revision: number; profile: { name: string } };

    const receipt = await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "rename-1",
      expectedRevision: before.revision,
      botId,
      profile: { name: "Renamed" },
    });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ status: "applied" });

    const after = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/settings`),
    )) as { revision: number; profile: { name: string } };
    expect(after.profile.name).toBe("Renamed");
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("refuses a stale expectedRevision with 409 revision-conflict", async () => {
    const userId = freshUserId("settings-conflict");
    const botId = "conflict-bot";
    await provisionThroughGateway({ userId, botId });

    const view = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/settings`),
    )) as { revision: number };
    const command = {
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "rename-conflict",
      expectedRevision: view.revision,
      botId,
      profile: { name: "First" },
    };
    expect(
      (await postAsUser(userId, `/api/bots/${botId}/settings`, command)).status,
    ).toBe(200);

    // The same revision a second time is now stale.
    const stale = await postAsUser(userId, `/api/bots/${botId}/settings`, {
      ...command,
      commandId: "rename-stale",
      profile: { name: "Second" },
    });
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toContain("application/json");
    expect(await stale.json()).toMatchObject({
      code: "revision-conflict",
      currentRevision: view.revision + 1,
    });
  });

  it("refuses a Bot command whose botId does not match the path", async () => {
    const userId = freshUserId("settings-path");
    const botId = "path-bot";
    await provisionThroughGateway({ userId, botId });

    const response = await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "rename-mismatch",
      expectedRevision: 0,
      botId: "other-bot",
      profile: { name: "Nope" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Bot command does not match the request path",
    });
  });
});
