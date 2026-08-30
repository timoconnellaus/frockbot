import { describe, expect, test } from "bun:test";
import { resolveBotSettingsModel } from "./bot-settings.js";

describe("Bot settings model selection", () => {
  test("preserves a model-less Bot while unrelated settings save", () => {
    expect(
      resolveBotSettingsModel({
        useExactModel: false,
        selectedModel: "",
        exactConnectionId: "",
        exactProviderModelId: "",
      }),
    ).toBeUndefined();
  });

  test("rejects malformed model selections before settings mutate", () => {
    expect(() =>
      resolveBotSettingsModel({
        useExactModel: false,
        selectedModel: "not-json",
        exactConnectionId: "",
        exactProviderModelId: "",
      }),
    ).toThrow("A Connection and model ID are required");
  });

  test("preserves an existing binding without a new selection", () => {
    expect(
      resolveBotSettingsModel({
        current: {
          connectionId: "ollama-1",
          providerModelId: "glm:cloud",
        },
        useExactModel: false,
        selectedModel: "",
        exactConnectionId: "",
        exactProviderModelId: "",
      }),
    ).toEqual({
      connectionId: "ollama-1",
      providerModelId: "glm:cloud",
    });
  });
});
