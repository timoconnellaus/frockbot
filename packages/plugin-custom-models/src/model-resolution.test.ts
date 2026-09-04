import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveBotModelV1,
  type BotSettingsViewV1,
  type ExecutionPackageDefinition,
  type ModelBindingV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import rawManifest from "../frockbot.json" with { type: "json" };

const platformModel: ModelBindingV1 = {
  connectionId: "flock-ai",
  providerModelId: "@frock/auto",
};
const accountModel: ModelBindingV1 = {
  connectionId: "flock-ai",
  providerModelId: "@frock/manual",
};
const botModel: ModelBindingV1 = {
  connectionId: "flock-ai",
  providerModelId: "@frock/bot",
};

const customManifest = decodeFrockBotManifest(rawManifest);
const packages: ExecutionPackageDefinition[] = [
  {
    packageId: "provider-flock-ai",
    version: "0.0.1",
    settings: [],
    capabilities: [
      {
        id: "flock-ai-models",
        kind: "model",
        connectionTypes: ["flock-ai-account"],
      },
    ],
    connectionTypes: [
      { id: "flock-ai-account", capabilities: ["flock-ai-models"] },
    ],
  },
  {
    packageId: customManifest.id,
    version: customManifest.version,
    settings: customManifest.configuration?.settings ?? [],
    capabilities: [],
    connectionTypes: [],
  },
];

function user(state: "disabled" | "installed"): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    profile: { name: "User" },
    packages: [
      {
        packageId: "provider-flock-ai",
        version: "0.0.1",
        state: "installed",
      },
      {
        packageId: "custom-models",
        version: "0.0.1",
        state,
        values: { "account-model": accountModel },
      },
    ],
    connections: [
      {
        connectionId: "flock-ai",
        packageId: "provider-flock-ai",
        connectionTypeId: "flock-ai-account",
        displayName: "Frock AI",
        state: "ready",
        providerType: "flock-ai",
        modelCatalog: {
          schemaVersion: 1,
          generation: "catalog-1",
          state: "fresh",
          models: [platformModel, accountModel, botModel].map((model) => ({
            providerModelId: model.providerModelId,
            displayName: model.providerModelId,
            capabilities: { tools: true, vision: false, reasoning: true },
            source: "discovered" as const,
          })),
        },
        safeMetadata: {},
      },
    ],
    platformModel,
  };
}

function bot(): BotSettingsViewV1 {
  return {
    schemaVersion: 1,
    botId: "scout",
    revision: 1,
    profile: { name: "Scout" },
    notifications: { enabled: true },
    packageValues: { "custom-models": { model: botModel } },
  };
}

describe("Custom models resolution", () => {
  test("ignores preserved Custom models values while disabled and restores Bot-over-account precedence when re-enabled", () => {
    const disabledUser = user("disabled");
    const configuredBot = bot();
    const storedAccountValues = structuredClone(
      disabledUser.packages[1]?.values,
    );
    const storedBotValues = structuredClone(configuredBot.packageValues);

    expect(
      resolveEffectiveBotModelV1({
        bot: configuredBot,
        user: disabledUser,
        packages,
      }),
    ).toMatchObject({ source: "platform", model: platformModel });
    expect(disabledUser.packages[1]?.values).toEqual(storedAccountValues);
    expect(configuredBot.packageValues).toEqual(storedBotValues);

    const enabledUser = user("installed");
    expect(
      resolveEffectiveBotModelV1({
        bot: configuredBot,
        user: enabledUser,
        packages,
      }),
    ).toMatchObject({ source: "bot", model: botModel });
    expect(
      resolveEffectiveBotModelV1({
        bot: { packageValues: {} },
        user: enabledUser,
        packages,
      }),
    ).toMatchObject({ source: "account", model: accountModel });

    const withoutAccount = user("installed");
    delete withoutAccount.packages[1]?.values;
    expect(
      resolveEffectiveBotModelV1({
        bot: { packageValues: {} },
        user: withoutAccount,
        packages,
      }),
    ).toMatchObject({ source: "platform", model: platformModel });
  });
});
