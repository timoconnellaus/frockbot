import { describe, expect, test } from "bun:test";
import {
  decodePackageIframeCatalogV1,
  decodePackageIframePageMessageV2,
  decodePackageIframeToolCommandV1,
  iframePageSlotAllowedV1,
  packageIframeExternalUrlAllowedV2,
  packageIframeFocusAllowedV2,
  packageIframeToolAllowedV1,
  PACKAGE_IFRAME_BRIDGE_VERSION,
} from "./iframe-ui.js";

describe("Package iframe bridge v2", () => {
  test("exactly decodes the two page-to-host messages", () => {
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 1,
        type: "callTool",
        name: "weather_lookup",
        input: { city: "Sydney" },
      }),
    ).toMatchObject({ type: "callTool", name: "weather_lookup" });
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 1,
        type: "resize",
        height: 320,
      }),
    ).toEqual({ schemaVersion: 1, type: "resize", height: 320 });
    expect(() =>
      decodePackageIframePageMessageV2({
        schemaVersion: 1,
        type: "resize",
        height: 320,
        token: "secret",
      }),
    ).toThrow("invalid fields");
  });

  test("keeps a version 1 page working and adds the version 2 messages", () => {
    // A v1 page's message decodes as v1 and is answered at v1, so a page
    // published before this bridge existed is unaffected by the bump.
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 1,
        type: "resize",
        height: 120,
      }).schemaVersion,
    ).toBe(1);
    expect(PACKAGE_IFRAME_BRIDGE_VERSION).toBe(2);
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "hello",
        bridgeVersion: 2,
      }),
    ).toEqual({ schemaVersion: 2, type: "hello", bridgeVersion: 2 });
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "focus",
        appletId: "todo.abc123",
      }),
    ).toEqual({ schemaVersion: 2, type: "focus", appletId: "todo.abc123" });
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "focus",
        appletId: null,
      }),
    ).toEqual({ schemaVersion: 2, type: "focus", appletId: null });
    expect(
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "openExternal",
        url: "https://ui.example.com/packages/a.html",
      }),
    ).toMatchObject({ type: "openExternal" });
  });

  test("fails closed on v2 messages claiming version 1 and on bad payloads", () => {
    // A page cannot reach a v2 capability by claiming the older version.
    for (const type of ["hello", "focus", "openExternal"]) {
      expect(() =>
        decodePackageIframePageMessageV2({
          schemaVersion: 1,
          type,
          appletId: null,
          url: "https://ui.example.com/",
          bridgeVersion: 1,
        }),
      ).toThrow("type is invalid");
    }
    expect(() =>
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "focus",
        appletId: "Not An Applet",
      }),
    ).toThrow("appletId is invalid");
    expect(() =>
      decodePackageIframePageMessageV2({
        schemaVersion: 2,
        type: "openExternal",
        url: "javascript:alert(1)",
      }),
    ).toThrow("url is invalid");
    expect(() =>
      decodePackageIframePageMessageV2({
        schemaVersion: 3,
        type: "resize",
        height: 1,
      }),
    ).toThrow("schemaVersion is unsupported");
  });

  test("an external open is limited to the artifact origin", () => {
    const origin = "https://ui.example.com";
    expect(
      packageIframeExternalUrlAllowedV2(`${origin}/packages/a.html`, origin),
    ).toBe(true);
    expect(
      packageIframeExternalUrlAllowedV2("https://evil.example.com/", origin),
    ).toBe(false);
    expect(packageIframeExternalUrlAllowedV2("not a url", origin)).toBe(false);
  });

  test("only the Package that owns the focus tool may change the focus", () => {
    expect(
      packageIframeFocusAllowedV2({
        declaredTools: ["applet_focus", "applet_list"],
      }),
    ).toBe(true);
    expect(
      packageIframeFocusAllowedV2({ declaredTools: ["weather_lookup"] }),
    ).toBe(false);
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
