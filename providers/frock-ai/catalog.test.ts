import { describe, expect, test } from "bun:test";
import {
  FROCK_AI_DEFAULT_MODEL,
  cloudflareModelIdForFrockIdV1,
  frockAiStaticCatalogV1,
  frockModelIdForCloudflareIdV1,
  gatewayModelForFrockIdV1,
  gatewayModelForFrockRequestV1,
  FROCK_AI_STRUCTURED_MODEL,
  normalizeFrockModelIdV1,
} from "./catalog.js";

describe("Frock AI catalog", () => {
  test("presents Cloudflare ids as Frock AI ids and maps them back", () => {
    const cloudflareId = "@cf/deepseek-ai/deepseek-v4-flash-0731";
    const frockId = "@frock/deepseek-ai/deepseek-v4-flash-0731";

    expect(frockModelIdForCloudflareIdV1(cloudflareId)).toBe(frockId);
    expect(cloudflareModelIdForFrockIdV1(frockId)).toBe(cloudflareId);
    expect(gatewayModelForFrockIdV1(frockId)).toBe(
      `workers-ai/${cloudflareId}`,
    );
  });

  test("lists Auto first and never exposes a Cloudflare id", () => {
    const catalog = frockAiStaticCatalogV1();

    expect(catalog.models[0]).toMatchObject({
      providerModelId: FROCK_AI_DEFAULT_MODEL,
      displayName: "Auto (recommended)",
    });
    expect(
      catalog.models.every((model) =>
        model.providerModelId.startsWith("@frock/"),
      ),
    ).toBe(true);
  });

  test("maps Auto to the configured dynamic route", () => {
    expect(gatewayModelForFrockIdV1(FROCK_AI_DEFAULT_MODEL)).toBe(
      "dynamic/flock-auto",
    );
    expect(
      gatewayModelForFrockIdV1(FROCK_AI_DEFAULT_MODEL, "production-auto"),
    ).toBe("dynamic/production-auto");
  });

  test("pins Auto schema work to a Workers AI model that supports it", () => {
    expect(gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, true)).toBe(
      FROCK_AI_STRUCTURED_MODEL,
    );
    expect(gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, false)).toBe(
      "dynamic/flock-auto",
    );
  });

  test("rejects ids outside the Frock AI namespace", () => {
    expect(() => gatewayModelForFrockIdV1("@cf/not/frock")).toThrow(
      'must start with "@frock/"',
    );
    expect(() => cloudflareModelIdForFrockIdV1("not-frock")).toThrow(
      'must start with "@frock/"',
    );
    expect(() => frockModelIdForCloudflareIdV1("@frock/not-cf")).toThrow(
      'must start with "@cf/"',
    );
  });

  test("reads a pre-rename @flock/ id as the @frock/ id it always meant", () => {
    expect(normalizeFrockModelIdV1("@flock/auto")).toBe(FROCK_AI_DEFAULT_MODEL);
    expect(
      normalizeFrockModelIdV1("@flock/deepseek-ai/deepseek-v4-flash-0731"),
    ).toBe("@frock/deepseek-ai/deepseek-v4-flash-0731");
    expect(normalizeFrockModelIdV1("@frock/auto")).toBe("@frock/auto");
    expect(normalizeFrockModelIdV1("gpt-4o")).toBe("gpt-4o");
  });

  test("resolves a legacy id to the same gateway model as its new spelling", () => {
    expect(gatewayModelForFrockIdV1("@flock/auto")).toBe(
      gatewayModelForFrockIdV1(FROCK_AI_DEFAULT_MODEL),
    );
    expect(
      gatewayModelForFrockIdV1("@flock/deepseek-ai/deepseek-v4-flash-0731"),
    ).toBe(
      gatewayModelForFrockIdV1("@frock/deepseek-ai/deepseek-v4-flash-0731"),
    );
    expect(
      cloudflareModelIdForFrockIdV1(
        "@flock/deepseek-ai/deepseek-v4-flash-0731",
      ),
    ).toBe("@cf/deepseek-ai/deepseek-v4-flash-0731");
  });
});
