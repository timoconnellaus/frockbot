import { describe, expect, test } from "bun:test";
import {
  MODEL_PRICE_TABLE_VERSION_V1,
  modelCostMicrosV1,
  resolveModelPriceV1,
  voiceCostMicrosV1,
  voiceIncrementCostMicrosV1,
} from "./pricing.js";

describe("billing prices", () => {
  test("prices cached and uncached tokens without double-counting reasoning", () => {
    expect(
      modelCostMicrosV1(
        "flock-ai",
        "@frock/deepseek-ai/deepseek-v4-flash-0731",
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 250_000,
          outputTokens: 100_000,
          reasoningTokens: 50_000,
        },
      ),
    ).toMatchObject({
      costMicros: 465_500,
      unknown: false,
      priceTableVersion: MODEL_PRICE_TABLE_VERSION_V1,
    });
  });

  test("normalizes Ollama cloud suffixes", () => {
    expect(
      resolveModelPriceV1("ollama-cloud", "glm-5.3-flash:cloud"),
    ).toMatchObject({ unknown: false });
  });

  test("uses and flags the conservative unknown-model rate", () => {
    expect(
      modelCostMicrosV1("private-provider", "new-model", {
        inputTokens: 10,
        outputTokens: 2,
      }),
    ).toMatchObject({ costMicros: 200, unknown: true });
  });

  test("prices voice by recorded duration", () => {
    expect(voiceCostMicrosV1(90)).toBe(25_500);
  });

  test("prices cumulative voice increments without report-frequency drift", () => {
    expect(
      voiceIncrementCostMicrosV1(1, 1) +
        voiceIncrementCostMicrosV1(2, 1) +
        voiceIncrementCostMicrosV1(3, 1),
    ).toBe(voiceCostMicrosV1(3));
  });
});
