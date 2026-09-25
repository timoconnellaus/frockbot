import { describe, expect, test } from "bun:test";
import {
  FROCK_AI_DEFAULT_MODEL,
  cloudflareModelIdForFrockIdV1,
  frockAiStaticCatalogV1,
  frockModelIdForCloudflareIdV1,
  gatewayModelForFrockIdV1,
  gatewayModelForFrockRequestV1,
  FROCK_AI_BINDING_AUTO_MODEL,
  FROCK_AI_STRUCTURED_MODEL,
  FROCK_AI_SPECIALTIES_V1,
  FROCK_AI_SUMMARY_MODEL,
  frockAiSpecialtyV1,
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

  test("sends each specialist to its own route, and lists none of them", () => {
    expect(gatewayModelForFrockIdV1("@frock/writing")).toBe(
      "dynamic/frock-writing",
    );
    // The pre-rename spelling names the same specialist.
    expect(gatewayModelForFrockIdV1("@flock/coding")).toBe(
      "dynamic/frock-coding",
    );
    expect(gatewayModelForFrockIdV1("@frock/vision", null)).toBe(
      FROCK_AI_BINDING_AUTO_MODEL,
    );
    expect(frockAiSpecialtyV1("@frock/thinking")?.name).toBe("thinking");
    expect(frockAiSpecialtyV1(FROCK_AI_DEFAULT_MODEL)).toBeUndefined();
    const listed = frockAiStaticCatalogV1().models.map(
      (model) => model.providerModelId,
    );
    for (const specialty of FROCK_AI_SPECIALTIES_V1) {
      expect(listed).not.toContain(specialty.model);
    }
  });

  test("sends the summary model to its own route, and never lists it", () => {
    expect(gatewayModelForFrockIdV1(FROCK_AI_SUMMARY_MODEL)).toBe(
      "dynamic/frock-structured",
    );
    // The binding carries no routes; its pinned Auto model has the context.
    expect(gatewayModelForFrockIdV1(FROCK_AI_SUMMARY_MODEL, null)).toBe(
      FROCK_AI_BINDING_AUTO_MODEL,
    );
    expect(
      frockAiStaticCatalogV1().models.map((model) => model.providerModelId),
    ).not.toContain(FROCK_AI_SUMMARY_MODEL);
  });

  test("pins Auto schema work to a Workers AI model that supports it", () => {
    expect(gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, true)).toBe(
      FROCK_AI_STRUCTURED_MODEL,
    );
    expect(gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, false)).toBe(
      "dynamic/flock-auto",
    );
  });

  test("resolves Auto to a concrete model where no route can carry it", () => {
    // The `AI` binding rejects `dynamic/<route>` before inference
    // (cloudflare/ai#617), so a deployment with no Gateway has Auto pinned
    // rather than broken — "the platform picks the model" with zero
    // configuration.
    expect(gatewayModelForFrockIdV1(FROCK_AI_DEFAULT_MODEL, null)).toBe(
      FROCK_AI_BINDING_AUTO_MODEL,
    );
    expect(FROCK_AI_BINDING_AUTO_MODEL.startsWith("workers-ai/@cf/")).toBe(
      true,
    );
    // It is a model this deployment actually offers, not an id nobody listed.
    expect(
      frockAiStaticCatalogV1().models.map(
        (model) =>
          `workers-ai/${model.providerModelId.replace("@frock/", "@cf/")}`,
      ),
    ).toContain(FROCK_AI_BINDING_AUTO_MODEL);
    expect(
      gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, false, null),
    ).toBe(FROCK_AI_BINDING_AUTO_MODEL);
    // Schema work still goes to the model that honours one.
    expect(
      gatewayModelForFrockRequestV1(FROCK_AI_DEFAULT_MODEL, true, null),
    ).toBe(FROCK_AI_STRUCTURED_MODEL);
    // A named model is unaffected: it never needed a route.
    expect(
      gatewayModelForFrockIdV1(
        "@frock/deepseek-ai/deepseek-v4-flash-0731",
        null,
      ),
    ).toBe("workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731");
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
