import { describe, expect, test } from "bun:test";
import {
  decodeModelSelection,
  describeModelAssignment,
  encodeModelSelection,
  eligibleModelConnections,
  isModelConnectionEligible,
  modelSelectOptions,
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
        settings: [],
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

describe("shared model option building", () => {
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
      settings: [],
    },
  ];
  const packages = [
    {
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
      state: "installed" as const,
    },
  ];
  const connections = [
    {
      connectionId: "ollama-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      state: "ready" as const,
      providerType: "ollama-cloud",
      modelCatalog: {
        schemaVersion: 1 as const,
        generation: "catalog-1",
        state: "fresh" as const,
        models: [
          {
            providerModelId: "llama-3:cloud",
            displayName: "Llama 3",
            capabilities: { tools: true, vision: false, reasoning: false },
            source: "discovered" as const,
          },
        ],
      },
      safeMetadata: {},
    },
    {
      connectionId: "ollama-2",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Revoked",
      state: "revoked" as const,
      safeMetadata: {},
    },
  ];

  test("offers one option per advertised model of an eligible Connection", () => {
    const eligible = eligibleModelConnections({
      connections,
      packages,
      catalog,
    });
    expect(eligible.map((connection) => connection.connectionId)).toEqual([
      "ollama-1",
    ]);
    expect(modelSelectOptions(eligible)).toEqual([
      {
        value: JSON.stringify(["ollama-1", "llama-3:cloud"]),
        label: "Llama 3 — Work",
      },
    ]);
  });

  test("round-trips a selection and names it for prose", () => {
    const model = {
      connectionId: "ollama-1",
      providerModelId: "llama-3:cloud",
    };
    expect(decodeModelSelection(encodeModelSelection(model))).toEqual(model);
    expect(encodeModelSelection(undefined)).toBe("");
    expect(decodeModelSelection("")).toBeUndefined();
    expect(() => decodeModelSelection("not-json")).toThrow(
      "A Connection and model ID are required",
    );
    expect(describeModelAssignment(model, connections)).toBe("Llama 3 — Work");
    expect(
      describeModelAssignment(
        { connectionId: "ollama-1", providerModelId: "custom:cloud" },
        connections,
      ),
    ).toBe("custom:cloud — Work");
    expect(describeModelAssignment(undefined, connections)).toBeUndefined();
  });
});
