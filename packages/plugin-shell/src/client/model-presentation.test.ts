import { describe, expect, test } from "bun:test";
import { modelRuntimeLabel } from "./model-presentation.js";

describe("model runtime presentation", () => {
  test("derives provider presentation from Package metadata", () => {
    expect(
      modelRuntimeLabel({
        packageDisplayName: "Ollama Cloud",
        connectionDisplayName: "Work",
        hasModel: true,
      }),
    ).toBe("Ollama Cloud · Dynamic Worker");
    expect(
      modelRuntimeLabel({
        connectionDisplayName: "Custom provider",
        hasModel: true,
      }),
    ).toBe("Custom provider · Dynamic Worker");
  });
});
