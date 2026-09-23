import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LEGACY_SETTINGS_STATE_KEY,
  legacyBotSettingsRecordV1,
  legacyUserSettingsRecordV1,
} from "../legacy-model-account.ts";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  useApplicationArtifact,
  flockRevision,
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
    // Custom models is platform-owned, so a migrated account holds it
    // installed without being asked.
    expect(migrated.packages).toContainEqual({
      packageId: "custom-models",
      state: "installed",
      version: "0.0.1",
      provenance: "first-party",
    });

    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-legacy-primary",
      expectedRevision: await flockRevision(userId),
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
