import { describe, expect, test } from "bun:test";
import { customModelsDefinitionV1 } from "./definition.js";
import { providerOllamaCloudDefinitionV1 } from "@frockbot/providers/ollama-cloud/definition";

describe("the Custom models definition", () => {
  test("is platform-owned and declares only the Bot model override setting", () => {
    // Every Bot may choose its own model; there is no account switch to find
    // first.
    expect(customModelsDefinitionV1).toMatchObject({
      id: "custom-models",
      displayName: "Custom models",
      platformOwned: true,
    });
    expect(customModelsDefinitionV1.defaultEnablement).toBeUndefined();
    expect(customModelsDefinitionV1.settings).toEqual([
      {
        id: "model",
        schemaVersion: 1,
        scopes: ["bot"],
        role: "model",
        schema: {
          type: "object",
          properties: {
            connectionId: { type: "string" },
            providerModelId: { type: "string" },
          },
          required: ["connectionId", "providerModelId"],
          additionalProperties: false,
        },
      },
    ]);
  });

  test("is not required to choose Ollama Cloud", () => {
    expect(providerOllamaCloudDefinitionV1.dependencies).not.toContain(
      "custom-models",
    );
  });
});
