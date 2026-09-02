import { describe, expect, test } from "bun:test";
import {
  decodeModelSelection,
  describeModelBinding,
  encodeModelSelection,
  eligibleModelConnections,
  isModelConnectionEligible,
  modelSelectOptions,
} from "./bot-settings.js";

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

describe("shared model option building", () => {
  test("requires an enabled model provider Package", () => {
    expect(
      isModelConnectionEligible({
        connection: connections[0]!,
        packages: [{ ...packages[0]!, state: "disabled" }],
        catalog,
      }),
    ).toBe(false);
    expect(
      isModelConnectionEligible({
        connection: connections[0]!,
        packages,
        catalog,
      }),
    ).toBe(true);
  });

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

  test("round-trips a binding and names it for prose", () => {
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
    expect(describeModelBinding(model, connections)).toBe("Llama 3 — Work");
    expect(
      describeModelBinding(
        { connectionId: "ollama-1", providerModelId: "custom:cloud" },
        connections,
      ),
    ).toBe("custom:cloud — Work");
    expect(describeModelBinding(undefined, connections)).toBeUndefined();
  });
});
