import { describe, expect, test } from "bun:test";
import {
  FLOCK_AI_DEFAULT_MODEL,
  cloudflareModelIdForFlockIdV1,
  flockAiStaticCatalogV1,
  flockModelIdForCloudflareIdV1,
  gatewayModelForFlockIdV1,
} from "./catalog.js";

describe("Flock AI catalog", () => {
  test("presents Cloudflare ids as Flock AI ids and maps them back", () => {
    const cloudflareId = "@cf/deepseek-ai/deepseek-v4-flash-0731";
    const flockId = "@flock/deepseek-ai/deepseek-v4-flash-0731";

    expect(flockModelIdForCloudflareIdV1(cloudflareId)).toBe(flockId);
    expect(cloudflareModelIdForFlockIdV1(flockId)).toBe(cloudflareId);
    expect(gatewayModelForFlockIdV1(flockId)).toBe(
      `workers-ai/${cloudflareId}`,
    );
  });

  test("lists Auto first and never exposes a Cloudflare id", () => {
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
    expect(() => cloudflareModelIdForFlockIdV1("not-flock")).toThrow(
      'must start with "@flock/"',
    );
    expect(() => flockModelIdForCloudflareIdV1("@flock/not-cf")).toThrow(
      'must start with "@cf/"',
    );
  });
});
