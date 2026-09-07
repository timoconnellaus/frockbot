import { describe, expect, test } from "bun:test";
import type { PackageIframeCompositionV1 } from "@frockbot/core/contracts";
import { requirePackageUiToolDeclarationV1 } from "./backend.js";
import { projectFirstPartyPackageIframeV1 } from "./composition-views.js";

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

  test("projects the Applets pages with no Composition generation", () => {
    expect(projected.botId).toBe("bot");
    expect(Object.keys(projected)).toEqual([
      "schemaVersion",
      "botId",
      "contributions",
    ]);
    const applets = projected.contributions.find(
      (contribution) => contribution.packageId === "applets",
    );
    expect(applets?.provenance).toBe("FrockBot");
    expect(applets?.pages.map((page) => page.id)).toEqual(["list", "canvas"]);
    expect(applets?.entries.map((entry) => entry.id)).toEqual(["open"]);
  });

  test("declares the one tool its pages may call", () => {
    const applets = projected.contributions.find(
      (contribution) => contribution.packageId === "applets",
    );
    expect(applets?.declaredTools).toEqual(["applet_focus"]);
    expect(
      requirePackageUiToolDeclarationV1(projected, {
        packageId: "applets",
        name: "applet_focus",
      }).displayName,
    ).toBe("Applets");
    expect(() =>
      requirePackageUiToolDeclarationV1(projected, {
        packageId: "applets",
        name: "applet_delete",
      }),
    ).toThrow('did not declare tool "applet_delete"');
  });

  test("addresses each page by the digest of the bytes it serves", async () => {
    for (const contribution of projected.contributions) {
      for (const page of contribution.pages) {
        expect(page.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(page.artifact.mediaType).toBe("text/html");
      }
    }
    const { FIRST_PARTY_PACKAGE_ARTIFACTS_V1 } =
      await import("@frockbot/applets/pages");
    for (const contribution of projected.contributions) {
      for (const page of contribution.pages) {
        const html = FIRST_PARTY_PACKAGE_ARTIFACTS_V1.get(
          `packages/${page.artifact.contentHash}.html`,
        );
        expect(html).toBeDefined();
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(html!),
        );
        expect(
          [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ).toBe(page.artifact.contentHash);
      }
    }
  });
});
