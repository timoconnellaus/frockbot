import { describe, expect, test } from "bun:test";
import {
  FLOCK_AI_DEFAULT_MODEL,
  flockAiStaticCatalogV1,
  flockModelIdForWorkersAiIdV1,
  gatewayModelForFlockIdV1,
  workersAiModelIdForFlockIdV1,
} from "./catalog.js";

describe("Flock AI catalog", () => {
  test("presents Workers AI ids as Flock AI ids and maps them back", () => {
    const workersAiId = "@cf/deepseek-ai/deepseek-v4-flash-0731";
    const flockId = "@flock/deepseek-ai/deepseek-v4-flash-0731";

    expect(flockModelIdForWorkersAiIdV1(workersAiId)).toBe(flockId);
    expect(workersAiModelIdForFlockIdV1(flockId)).toBe(workersAiId);
    expect(gatewayModelForFlockIdV1(flockId)).toBe(`workers-ai/${workersAiId}`);
  });

  test("lists Auto first and never exposes a Workers AI id", () => {
    const catalog = flockAiStaticCatalogV1();

    expect(catalog.models[0]).toMatchObject({
      providerModelId: FLOCK_AI_DEFAULT_MODEL,
      displayName: "Auto (recommended)",
    });
    expect(
      catalog.models.every((model) =>
        model.providerModelId.startsWith("@flock/"),
      ),
    ).toBe(true);
  });

  test("maps Auto to the configured dynamic route", () => {
    expect(gatewayModelForFlockIdV1(FLOCK_AI_DEFAULT_MODEL)).toBe(
      "dynamic/flock-auto",
    );
    expect(
      gatewayModelForFlockIdV1(FLOCK_AI_DEFAULT_MODEL, "production-auto"),
    ).toBe("dynamic/production-auto");
  });

  test("rejects ids outside the Flock AI namespace", () => {
    expect(() => gatewayModelForFlockIdV1("@cf/not/flock")).toThrow(
      'must start with "@flock/"',
    );
    expect(() => workersAiModelIdForFlockIdV1("not-flock")).toThrow(
      'must start with "@flock/"',
    );
    expect(() => flockModelIdForWorkersAiIdV1("@flock/not-cf")).toThrow(
      'must start with "@cf/"',
    );
  });
});
