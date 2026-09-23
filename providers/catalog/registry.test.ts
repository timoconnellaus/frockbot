import { describe, expect, test } from "bun:test";
import { catalogProviderDefinitionsV1 } from "./definition.js";
import {
  catalogProviderV1,
  catalogRuntimeEnvironmentV1,
  validateCatalogSettingsV1,
} from "./registry.js";

function connectionSettings(providerId: string): string[] {
  const definition = catalogProviderDefinitionsV1.find(
    ({ id }) => id === `provider-${providerId}`,
  );
  const connection = definition?.connectionTypes?.find(
    ({ id }) => id === `${providerId}-account`,
  );
  return connection?.settings?.map(({ id }) => id) ?? [];
}

describe("catalog provider registry", () => {
  test("drives provider definitions and dispatch strategies", () => {
    expect(connectionSettings("amazon-bedrock")).toEqual([
      "api-base-url",
      "region",
    ]);
    expect(connectionSettings("cloudflare-ai-gateway")).toEqual([
      "api-base-url",
      "account-id",
      "gateway-id",
    ]);
    expect(connectionSettings("azure-openai-responses")).toEqual([
      "api-base-url",
      "api-version",
    ]);

    expect(catalogProviderV1("amazon-bedrock").runtimeAdapter).toBe("bedrock");
    expect(catalogProviderV1("xai").oauthProviderId).toBe("xai");
    expect(catalogProviderV1("radius").modelSource).toBe("radius-gateway");
    expect(catalogProviderV1("google")).toMatchObject({
      runtimeAdapter: "pi-ai",
      oauthProviderId: undefined,
      modelSource: "builtin",
    });
  });

  test("names only connector icons the app bundles", async () => {
    const icons = new Set(
      catalogProviderDefinitionsV1.flatMap((definition) =>
        (definition.connectionTypes ?? []).flatMap((type) =>
          type.icon ? [type.icon] : [],
        ),
      ),
    );
    const missing: string[] = [];
    for (const icon of icons) {
      const asset = new URL(
        `../../apps/native/assets/connectors/${icon}.png`,
        import.meta.url,
      );
      if (!(await Bun.file(asset).exists())) missing.push(icon);
    }
    expect(missing).toEqual([]);
  });

  test("owns settings validation and runtime environment names", () => {
    expect(() =>
      validateCatalogSettingsV1(
        catalogProviderV1("azure-openai-responses"),
        {},
      ),
    ).toThrow("Azure requires");
    expect(() =>
      validateCatalogSettingsV1(catalogProviderV1("cloudflare-workers-ai"), {
        "account-id": "invalid",
      }),
    ).toThrow("valid account ID");
    expect(() =>
      validateCatalogSettingsV1(catalogProviderV1("cloudflare-ai-gateway"), {
        "account-id": "a".repeat(32),
      }),
    ).toThrow("gateway ID");
    expect(() =>
      validateCatalogSettingsV1(catalogProviderV1("google"), {
        region: "invalid",
      }),
    ).toThrow("AWS region is invalid");

    expect(
      catalogRuntimeEnvironmentV1({
        region: "us-east-1",
        "account-id": "account",
        "gateway-id": "gateway",
        "api-version": "2026-09-01",
        ignored: "value",
      }),
    ).toEqual({
      AWS_REGION: "us-east-1",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_GATEWAY_ID: "gateway",
      AZURE_OPENAI_API_VERSION: "2026-09-01",
    });
  });
});
