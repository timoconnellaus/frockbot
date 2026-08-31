import { describe, expect, test } from "bun:test";
import {
  isModelConnectionEligible,
  resolveBotSettingsModel,
} from "./bot-settings.js";

describe("Bot settings model selection", () => {
  test("excludes model Connections owned by disabled Packages", () => {
    const connection = {
      connectionId: "ollama-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready" as const,
      providerType: "ollama-cloud",
      generation: "generation-1",
      safeMetadata: {},
    };
    const catalog = [
      {
        packageId: "provider-ollama-cloud",
        displayName: "Ollama Cloud",
        version: "0.0.1",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model" as const,
            connectionTypes: ["ollama-cloud-account"],
          },
        ],
        connectionTypes: [
          {
            id: "ollama-cloud-account",
            displayName: "Ollama Cloud account",
            allowMultiple: true,
            authorizationKind: "api-key" as const,
            capabilities: ["ollama-cloud-models"],
          },
        ],
      },
    ];

    expect(
      isModelConnectionEligible({
        connection,
        packages: [
          {
            packageId: "provider-ollama-cloud",
            version: "0.0.1",
            state: "disabled",
          },
        ],
        catalog,
      }),
    ).toBe(false);
    expect(
      isModelConnectionEligible({
        connection,
        packages: [
          {
            packageId: "provider-ollama-cloud",
            version: "0.0.1",
            state: "installed",
          },
        ],
        catalog,
      }),
    ).toBe(true);
  });

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
