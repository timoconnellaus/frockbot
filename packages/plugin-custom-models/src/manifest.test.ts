import { describe, expect, test } from "bun:test";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import type { PackageSettingSchema } from "@frockbot/kernel-composition";
import foundationApplication from "../../../applications/foundation/frockbot.application.json" with { type: "json" };
import ollamaManifest from "../../plugin-provider-ollama-cloud/frockbot.json" with { type: "json" };
import rawManifest from "../frockbot.json" with { type: "json" };

const MODEL_BINDING_SCHEMA = {
  type: "object",
  properties: {
    connectionId: { type: "string" },
    providerModelId: { type: "string" },
  },
  required: ["connectionId", "providerModelId"],
  additionalProperties: false,
} satisfies PackageSettingSchema;

describe("Custom models manifest", () => {
  test("is default-disabled and declares only the Bot model override setting", () => {
    const manifest = decodeFrockBotManifest(rawManifest);

    expect(manifest).toMatchObject({
      id: "custom-models",
      displayName: "Custom models",
      version: "0.0.1",
      defaultEnablement: "disabled",
    });
    expect(manifest.configuration?.settings).toEqual([
      {
        id: "model",
        schemaVersion: 1,
        scopes: ["bot"],
        role: "model",
        schema: MODEL_BINDING_SCHEMA,
      },
    ]);
  });

  test("is registered first-party in Foundation", () => {
    expect(foundationApplication.packages).toContainEqual({
      specifier: "@frockbot/plugin-custom-models",
      version: "0.0.1",
      grants: [],
    });
  });

  test("is not required to choose Ollama Cloud", () => {
    expect(ollamaManifest.dependencies).not.toHaveProperty("custom-models");
  });
});
