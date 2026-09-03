import { describe, expect, test } from "bun:test";
import {
  decodePackageIframeCatalogV1,
  decodePackageIframePageMessageV1,
  decodePackageIframeToolCommandV1,
  iframePageSlotAllowedV1,
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

  const artifact = (hash: string) => ({
    contentHash: hash.repeat(64),
    size: 256 * 1024,
    mediaType: "text/html",
    bundlerVersion: "frockbot-inline-html@1",
  });

  const catalog = () => ({
    schemaVersion: 1,
    botId: "bot",
    generationId: "generation-1",
    artifactOrigin: "https://ui.bot.frockbot.com",
    contributions: [
      {
        packageId: "weather-page",
        displayName: "Weather page",
        provenance: "Bot-authored",
        pages: [
          {
            id: "main",
            artifact: artifact("a"),
            mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
          },
          {
            id: "board",
            artifact: artifact("b"),
            mounts: [
              { slot: "frockbot.surface:board" },
              { slot: "frockbot.right-panel" },
            ],
          },
        ],
        entries: [
          {
            id: "open",
            slot: "frockbot.sidebar-actions",
            order: 5,
            label: "Weather board",
            icon: "sparkle",
            opens: { kind: "surface", page: "board" },
          },
        ],
        declaredTools: ["weather_lookup"],
      },
    ],
  });

  const withContribution = (patch: Record<string, unknown>) => ({
    ...catalog(),
    contributions: [{ ...catalog().contributions[0]!, ...patch }],
  });

  test("bounds projected HTML artifacts at the catalog seam", () => {
    const decoded = decodePackageIframeCatalogV1(catalog());
    expect(decoded.contributions).toHaveLength(1);
    expect(decoded.contributions[0]!.pages.map((page) => page.id)).toEqual([
      "main",
      "board",
    ]);
    expect(decoded.contributions[0]!.entries).toHaveLength(1);
    expect(() =>
      decodePackageIframeCatalogV1(
        withContribution({
          pages: [
            {
              ...catalog().contributions[0]!.pages[0]!,
              artifact: { ...artifact("a"), size: 256 * 1024 + 1 },
            },
          ],
          entries: [],
        }),
      ),
    ).toThrow("metadata is invalid");
  });

  test("refuses catalog pages and entries outside the manifest rules", () => {
    expect(() =>
      decodePackageIframeCatalogV1(withContribution({ pages: [] })),
    ).toThrow("non-empty bounded array");
    expect(() =>
      decodePackageIframeCatalogV1(
        withContribution({
          pages: [
            {
              id: "main",
              artifact: artifact("a"),
              mounts: [{ slot: "frockbot.surface:absent" }],
            },
          ],
          entries: [],
        }),
      ),
    ).toThrow("unsafe slot");
    expect(() =>
      decodePackageIframeCatalogV1(
        withContribution({
          entries: [
            {
              ...catalog().contributions[0]!.entries[0]!,
              opens: { kind: "surface", page: "main" },
            },
          ],
        }),
      ),
    ).toThrow("names no surface page");
    expect(() =>
      decodePackageIframeCatalogV1(
        withContribution({
          pages: [
            catalog().contributions[0]!.pages[0]!,
            { ...catalog().contributions[0]!.pages[1]!, id: "main" },
          ],
        }),
      ),
    ).toThrow("duplicate ids");
  });

  test("names one slot rule for every iframe seam", () => {
    const context = { declaredTools: ["weather_lookup"], pageIds: ["board"] };
    for (const slot of [
      "frockbot.bot-settings-sections",
      "frockbot.right-panel",
      "frockbot.tool-result:weather_lookup",
      "frockbot.surface:board",
    ]) {
      expect(iframePageSlotAllowedV1(slot, context)).toBe(true);
    }
    for (const slot of [
      "root",
      "frockbot.sidebar-actions",
      "frockbot.tool-result:package_author",
      "frockbot.surface:list",
    ]) {
      expect(iframePageSlotAllowedV1(slot, context)).toBe(false);
    }
  });
});
