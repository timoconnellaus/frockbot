import { describe, expect, test } from "bun:test";
import type { PackageIframeCompositionV1 } from "@frockbot/kernel-contracts";
import { requirePackageUiToolDeclarationV1 } from "./backend.js";

describe("Package iframe server admission", () => {
  const catalog: PackageIframeCompositionV1 = {
    schemaVersion: 1,
    botId: "bot",
    generationId: "generation-1",
    contributions: [
      {
        packageId: "weather-page",
        displayName: "Weather page",
        provenance: "Bot-authored",
        artifact: {
          contentHash: "a".repeat(64),
          size: 123,
          mediaType: "text/html",
          bundlerVersion: "frockbot-inline-html@1",
        },
        mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        declaredTools: ["weather_lookup"],
      },
    ],
  };

  test("refuses an undeclared tool before admitting a durable Turn", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        generationId: "generation-1",
        packageId: "weather-page",
        name: "package_author",
      }),
    ).toThrow('did not declare tool "package_author"');
  });

  test("refuses a stale page after its Composition generation changed", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        generationId: "generation-old",
        packageId: "weather-page",
        name: "weather_lookup",
      }),
    ).toThrow('generation "generation-old"');
  });
});
