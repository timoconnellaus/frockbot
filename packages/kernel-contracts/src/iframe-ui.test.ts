import { describe, expect, test } from "bun:test";
import {
  decodePackageIframeCatalogV1,
  decodePackageIframePageMessageV1,
  decodePackageIframeToolCommandV1,
  packageIframeToolAllowedV1,
} from "./iframe-ui.js";

describe("Package iframe bridge v1", () => {
  test("exactly decodes the two page-to-host messages", () => {
    expect(
      decodePackageIframePageMessageV1({
        schemaVersion: 1,
        type: "callTool",
        name: "weather_lookup",
        input: { city: "Sydney" },
      }),
    ).toMatchObject({ type: "callTool", name: "weather_lookup" });
    expect(
      decodePackageIframePageMessageV1({
        schemaVersion: 1,
        type: "resize",
        height: 320,
      }),
    ).toEqual({ schemaVersion: 1, type: "resize", height: 320 });
    expect(() =>
      decodePackageIframePageMessageV1({
        schemaVersion: 1,
        type: "resize",
        height: 320,
        token: "secret",
      }),
    ).toThrow("invalid fields");
  });

  test("refuses a tool the Package did not declare", () => {
    const contribution = { declaredTools: ["weather_lookup"] };
    expect(packageIframeToolAllowedV1(contribution, "weather_lookup")).toBe(
      true,
    );
    expect(packageIframeToolAllowedV1(contribution, "package_author")).toBe(
      false,
    );
  });

  test("exactly decodes the durable tool command", () => {
    const command = {
      schemaVersion: 1 as const,
      commandId: "command-1",
      generationId: "generation-1",
      packageId: "weather-lookup",
      name: "weather_lookup",
      input: { city: "Sydney" },
    };
    expect(decodePackageIframeToolCommandV1(command)).toEqual(command);
    expect(() =>
      decodePackageIframeToolCommandV1({ ...command, authToken: "nope" }),
    ).toThrow("invalid fields");
  });

  test("bounds projected HTML artifacts at the catalog seam", () => {
    const catalog = {
      schemaVersion: 1,
      botId: "bot",
      generationId: "generation-1",
      artifactOrigin: "https://ui.bot.frockbot.com",
      contributions: [
        {
          packageId: "weather-page",
          displayName: "Weather page",
          provenance: "Bot-authored",
          artifact: {
            contentHash: "a".repeat(64),
            size: 256 * 1024,
            mediaType: "text/html",
            bundlerVersion: "frockbot-inline-html@1",
          },
          mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
          declaredTools: ["weather_lookup"],
        },
      ],
    };
    expect(decodePackageIframeCatalogV1(catalog).contributions).toHaveLength(1);
    expect(() =>
      decodePackageIframeCatalogV1({
        ...catalog,
        contributions: [
          {
            ...catalog.contributions[0],
            artifact: {
              ...catalog.contributions[0]!.artifact,
              size: 256 * 1024 + 1,
            },
          },
        ],
      }),
    ).toThrow("metadata is invalid");
  });
});
