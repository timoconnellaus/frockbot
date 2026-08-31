import { describe, expect, test } from "bun:test";
import { modelRuntimeLabel } from "./model-presentation.js";

describe("model runtime presentation", () => {
  test("names the model and its provider Package", () => {
    expect(
      modelRuntimeLabel({
        modelDisplayName: "Llama 3",
        providerModelId: "llama-3:cloud",
        packageDisplayName: "Ollama Cloud",
        connectionDisplayName: "Work",
        hasModel: true,
      }),
    ).toBe("Llama 3 · Ollama Cloud");
    expect(
      modelRuntimeLabel({
        providerModelId: "llama-3:cloud",
        connectionDisplayName: "Custom provider",
        hasModel: true,
      }),
    ).toBe("llama-3:cloud · Custom provider");
  });

  test("reads the same whether the model is the Bot's or the User default", () => {
    const label = {
      modelDisplayName: "Llama 3",
      packageDisplayName: "Ollama Cloud",
      hasModel: true,
    };
    expect(modelRuntimeLabel(label)).toBe("Llama 3 · Ollama Cloud");
    expect(modelRuntimeLabel({ ...label, hasModel: false })).toBe(
      "No default model",
    );
  });
});
