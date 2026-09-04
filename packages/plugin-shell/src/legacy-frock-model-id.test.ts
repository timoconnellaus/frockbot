import { describe, expect, test } from "bun:test";
import {
  decodeModelBindingV1,
  decodeUserSettingsViewV1,
  resolveBotModelBindingV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { modelRuntimeLabel } from "./client/model-presentation.js";

/**
 * Bots bound before the provider was renamed carry `@flock/auto` in durable
 * storage. Reading one must land in exactly the same place as reading
 * `@frock/auto`: the same binding, the same resolution, the same line above
 * the composer. Nothing writes the old spelling back.
 */

const FROCK_PACKAGE = {
  packageId: "provider-flock-ai",
  version: "0.0.1",
  settings: [],
  capabilities: [
    {
      id: "flock-ai-models",
      kind: "model" as const,
      connectionTypes: ["flock-ai-account"],
    },
  ],
  connectionTypes: [
    { id: "flock-ai-account", capabilities: ["flock-ai-models"] },
  ],
};

function storedUserSettings(providerModelId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 7,
    profile: { name: "FrockBot user" },
    packages: [
      { packageId: "provider-flock-ai", version: "0.0.1", state: "installed" },
    ],
    connections: [
      {
        connectionId: "flock-ai-ambient",
        packageId: "provider-flock-ai",
        connectionTypeId: "flock-ai-account",
        displayName: "Frock AI",
        state: "ready",
        generation: "flock-ai-ambient-v1",
        providerType: "flock-ai",
        safeMetadata: {},
        modelCatalog: {
          schemaVersion: 1,
          generation: "flock-ai-static-v1",
          state: "fresh",
          models: [
            {
              providerModelId: "@frock/auto",
              displayName: "Auto (recommended)",
              capabilities: { tools: true, vision: false, reasoning: true },
              source: "discovered",
            },
          ],
        },
      },
    ],
    platformModel: { connectionId: "flock-ai-ambient", providerModelId },
  };
}

function storedBotModelOverride(
  providerModelId: string,
): Record<string, unknown> {
  return { connectionId: "flock-ai-ambient", providerModelId };
}

function composerLine(user: UserSettingsViewV1): string {
  const model = user.platformModel!;
  const binding = resolveBotModelBindingV1({
    model,
    user,
    packages: [FROCK_PACKAGE],
  });
  const connection = binding.connection;
  return modelRuntimeLabel({
    source: "platform",
    modelDisplayName: connection?.modelCatalog?.models.find(
      (candidate) => candidate.providerModelId === model.providerModelId,
    )?.displayName,
    providerModelId: model.providerModelId,
    packageDisplayName: "Frock AI",
    connectionDisplayName: connection?.displayName,
    failure: binding.failure,
  });
}

describe("a pre-rename @flock/ model binding", () => {
  test("decodes to the @frock/ spelling", () => {
    expect(decodeUserSettingsViewV1(storedUserSettings("@flock/auto"))).toEqual(
      decodeUserSettingsViewV1(storedUserSettings("@frock/auto")),
    );

    expect(
      decodeUserSettingsViewV1(storedUserSettings("@flock/auto")).platformModel
        ?.providerModelId,
    ).toBe("@frock/auto");
  });

  test("decodes the same way on a Bot's own model override", () => {
    // A Bot override is stored opaquely in `packageValues` and read back
    // through this decoder by `storedModelBindingV1`.
    const legacy = decodeModelBindingV1(storedBotModelOverride("@flock/auto"));

    expect(legacy).toEqual(
      decodeModelBindingV1(storedBotModelOverride("@frock/auto")),
    );
    expect(legacy.providerModelId).toBe("@frock/auto");
  });

  test("resolves against the catalog exactly as the new spelling does", () => {
    const legacy = resolveBotModelBindingV1({
      model: decodeUserSettingsViewV1(storedUserSettings("@flock/auto"))
        .platformModel!,
      user: decodeUserSettingsViewV1(storedUserSettings("@flock/auto")),
      packages: [FROCK_PACKAGE],
    });

    expect(legacy.state).toBe("ready");
    expect(legacy).toEqual(
      resolveBotModelBindingV1({
        model: decodeUserSettingsViewV1(storedUserSettings("@frock/auto"))
          .platformModel!,
        user: decodeUserSettingsViewV1(storedUserSettings("@frock/auto")),
        packages: [FROCK_PACKAGE],
      }),
    );
  });

  test("shows the Frock AI settings line, not a raw legacy id", () => {
    const line = composerLine(
      decodeUserSettingsViewV1(storedUserSettings("@flock/auto")),
    );

    expect(line).toBe("Auto (recommended) · Frock AI");
    expect(line).toBe(
      composerLine(decodeUserSettingsViewV1(storedUserSettings("@frock/auto"))),
    );
  });
});
