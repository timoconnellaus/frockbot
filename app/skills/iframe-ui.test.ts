import { describe, expect, test } from "bun:test";
import type { PackageIframeCompositionV1 } from "@frockbot/core/contracts";
import { requirePackageUiToolDeclarationV1 } from "./bot.js";
import { projectFirstPartyPackageIframeV1 } from "@frockbot/app/shell/composition-views";

describe("Package iframe server admission", () => {
  const catalog: PackageIframeCompositionV1 = {
    schemaVersion: 1,
    botId: "bot",
    contributions: [
      {
        packageId: "weather-page",
        displayName: "Weather page",
        provenance: "FrockBot",
        pages: [
          {
            id: "main",
            artifact: {
              contentHash: "a".repeat(64),
              size: 123,
              mediaType: "text/html",
              bundlerVersion: "frockbot-inline-html@1",
            },
            mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
          },
        ],
        entries: [],
        declaredTools: ["weather_lookup"],
      },
    ],
  };

  test("refuses an undeclared tool before admitting a durable Turn", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        packageId: "weather-page",
        name: "package_author",
      }),
    ).toThrow('did not declare tool "package_author"');
  });

  test("refuses a page of a Package the deployment does not ship", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        packageId: "retired-page",
        name: "weather_lookup",
      }),
    ).toThrow('Package "retired-page" did not declare tool "weather_lookup"');
  });
});

describe("the first-party page registry", () => {
  const projected = projectFirstPartyPackageIframeV1("bot");

  test("returns an empty contributions list after Applets deletion (ADR 0034)", () => {
    expect(projected.botId).toBe("bot");
    expect(projected.contributions).toEqual([]);
  });
});
