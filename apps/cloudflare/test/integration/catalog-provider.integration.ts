import { expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  asUser,
  expectOkJson,
  freshUserId,
  OLLAMA_GOOD_API_KEY,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";
import { providerModelsV1 } from "../../../../providers/catalog/models.js";

useApplicationArtifact();

it("starts OAuth and reads capability-scoped progress through the built Worker", async () => {
  const userId = freshUserId("catalog-oauth");
  const attemptId = "connect-xai";
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-xai",
      expectedRevision: settings.revision,
      packageId: "provider-xai",
      version: "0.0.1",
    }),
  );

  const startResponse = await postAsUser(
    userId,
    "/api/plugins/provider-xai/connections",
    {
      schemaVersion: 1,
      type: "connection/start",
      commandId: attemptId,
      connectionTypeId: "xai-oauth",
      alias: "XAI test",
    },
  );
  const startBody = await startResponse.text();
  expect(startResponse.status, startBody).toBe(200);
  const started = JSON.parse(startBody) as {
    status: string;
    redirectUrl: string;
  };
  expect(started.status).toBe("authorization-required");
  const redirect = new URL(started.redirectUrl);
  expect(redirect.search).toBe("");
  const parameters = new URLSearchParams(redirect.hash.slice(1));
  expect(parameters.get("userId")).toBe(userId);
  expect(parameters.get("attemptId")).toBe(attemptId);

  const progressResponse = await SELF.fetch(
    "https://bot.frockbot.com/api/model-oauth/progress",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId,
        packageId: "provider-xai",
        attemptId,
        browserKey: parameters.get("browserKey"),
        action: "check",
      }),
    },
  );
  const progress = (await expectOkJson(progressResponse)) as {
    oauth: Record<string, unknown>;
  };
  expect(progress.oauth).toMatchObject({
    status: "waiting",
    authorizationUrl: "https://console.x.ai/device",
    userCode: "XAI-INTEGRATION",
  });
  expect(JSON.stringify(progress)).not.toContain(
    "integration-xai-device-secret",
  );
});

it("connects a catalog provider and completes repeated tool turns through the built Worker", async () => {
  const userId = freshUserId("catalog-provider");
  const botId = "catalog-bot";
  await provisionThroughGateway({ userId, botId });
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-deepseek",
      expectedRevision: settings.revision,
      packageId: "provider-deepseek",
      version: "0.0.1",
    }),
  );
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "connect-deepseek",
      packageId: "provider-deepseek",
      connectionTypeId: "deepseek-account",
      label: "DeepSeek test",
      apiKey: OLLAMA_GOOD_API_KEY,
      settings: { "api-base-url": "https://ollama.com/v1" },
    }),
  )) as { status: string; connectionId: string };
  expect(receipt.status).toBe("applied");
  const updated = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/set-account-model",
      commandId: "select-deepseek",
      expectedRevision: updated.revision,
      model: {
        connectionId: receipt.connectionId,
        providerModelId: providerModelsV1("deepseek")[0]!.id,
      },
    }),
  );
  for (let index = 0; index < 2; index++) {
    const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: `turn-${index}`,
      text: "hello",
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("Ollama reply");
  }
});
