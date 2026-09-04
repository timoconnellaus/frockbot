import { describe, expect, test } from "bun:test";
import { modelRuntimeLabel } from "./model-presentation.js";

describe("model runtime presentation", () => {
  test("names platform models plainly", () => {
    expect(
      modelRuntimeLabel({
        source: "platform",
        modelDisplayName: "Llama 3",
        providerModelId: "llama-3:cloud",
        packageDisplayName: "Ollama Cloud",
        connectionDisplayName: "Work",
      }),
    ).toBe("Llama 3 · Ollama Cloud");
    expect(
      modelRuntimeLabel({
        source: "platform",
        providerModelId: "llama-3:cloud",
        connectionDisplayName: "Custom provider",
      }),
    ).toBe("llama-3:cloud · Custom provider");
  });

  test("distinguishes opt-in account and Bot choices", () => {
    const label = {
      modelDisplayName: "Llama 3",
      providerModelId: "llama-3:cloud",
      packageDisplayName: "Ollama Cloud",
    };
    expect(modelRuntimeLabel({ ...label, source: "account" })).toBe(
      "Llama 3 · Ollama Cloud · Account model",
    );
    expect(modelRuntimeLabel({ ...label, source: "bot" })).toBe(
      "Llama 3 · Ollama Cloud · this Bot only",
    );
  });

  test("names the stand-in model when the chosen one is unavailable", () => {
    // The Bot is answering, so the line is not a failure — it names the model
    // actually in use and says the User's own choice is not it.
    expect(
      modelRuntimeLabel({
        source: "platform",
        modelDisplayName: "Auto",
        providerModelId: "@flock/auto",
        packageDisplayName: "Flock AI",
        fallback: true,
      }),
    ).toBe("Auto · Flock AI · your chosen model is unavailable");
  });

  test("shows unavailable and backend failure states", () => {
    expect(modelRuntimeLabel({ source: "none" })).toBe(
      "No model available — set one up in Models",
    );
    expect(
      modelRuntimeLabel({
        source: "account",
        providerModelId: "llama-3:cloud",
        failure: 'Connection "work" is revoked; enable or reconnect it',
      }),
    ).toBe('Connection "work" is revoked; enable or reconnect it');
    const disabledProvider =
      'Package "provider-ollama-cloud" is not installed and enabled; enable it to use Connection "ollama-legacy"';
    expect(
      modelRuntimeLabel({
        source: "account",
        providerModelId: "glm-5.3-flash:cloud",
        failure: disabledProvider,
      }),
    ).toBe(disabledProvider);
  });
});
