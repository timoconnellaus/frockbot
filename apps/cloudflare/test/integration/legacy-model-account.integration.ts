import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DEFAULT_PACKAGES_MARKER_KEY,
  LEGACY_SETTINGS_STATE_KEY,
  legacyBotSettingsRecordV1,
  legacyDefaultPackagesMarkerV1,
  legacyUserSettingsRecordV1,
} from "../legacy-model-account.ts";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("legacy model account migration through the gateway", () => {
  it("enables Custom models and admits the Bot's next Turn on Frock AI", async () => {
    const userId = freshUserId("legacy-model");
    const botId = "primary";
    await runInDurableObject(
      env.USER_CONFIGURATIONS.getByName(userId),
      async (_instance, state) => {
        await state.storage.put({
          [LEGACY_SETTINGS_STATE_KEY]: legacyUserSettingsRecordV1(),
          [LEGACY_DEFAULT_PACKAGES_MARKER_KEY]: legacyDefaultPackagesMarkerV1(),
        });
      },
    );

    const migrated = (await expectOkJson(
      await asUser(userId, "/api/settings"),
    )) as {
      revision: number;
      platformModel?: { connectionId: string; providerModelId: string };
      packages: Array<{ packageId: string; state: string }>;
    };
    expect(migrated.platformModel).toEqual({
      connectionId: "flock-ai-ambient",
      providerModelId: "@frock/auto",
    });
    expect(migrated.packages).not.toContainEqual(
      expect.objectContaining({ packageId: "provider-workers-ai" }),
    );
    expect(migrated.packages).toContainEqual({
      packageId: "custom-models",
      state: "disabled",
      version: "0.0.1",
      provenance: "first-party",
    });

    const enabled = (await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "enable-custom-models-after-migration",
        expectedRevision: migrated.revision,
        packageId: "custom-models",
        enabled: true,
      }),
    )) as { status: string };
    expect(enabled.status).toBe("applied");

    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-legacy-primary",
      expectedRevision: 0,
      botId,
      name: "Primary",
    });
    expect(created.status).toBe(201);
    await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) => {
        await state.storage.put(
          "bot-configuration",
          legacyBotSettingsRecordV1(botId),
        );
      },
    );

    const turn = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "legacy-account-next-turn",
      text: "hello",
    });
    expect(turn.status).toBe(200);
    expect(JSON.stringify(await turn.json())).toContain("Frock AI reply");
  });
});
