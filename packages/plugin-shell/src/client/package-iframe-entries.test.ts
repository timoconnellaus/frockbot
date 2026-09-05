import { describe, expect, test } from "bun:test";
import type {
  PackageIframeCatalogV1,
  PackageIframeContributionViewV1,
} from "@frockbot/kernel-contracts";
import {
  packageIframeEntriesV1,
  packageIframePagesForSlotV1,
  packageIframeSurfaceIdV1,
  PACKAGE_IFRAME_ENTRY_DEFAULT_ORDER_V1,
} from "./package-iframe-entries.js";

const artifact = {
  contentHash: "a".repeat(64),
  size: 128,
  mediaType: "text/html" as const,
  bundlerVersion: "frockbot-inline-html@1",
};

function contribution(
  packageId: string,
  entryOrder: number | undefined,
  pageId = "list",
): PackageIframeContributionViewV1 {
  return {
    packageId,
    displayName: packageId,
    provenance: "Bot-authored",
    pages: [
      {
        id: pageId,
        artifact,
        mounts: [{ slot: `frockbot.surface:${pageId}` }],
      },
      { id: "canvas", artifact, mounts: [{ slot: "frockbot.right-panel" }] },
    ],
    entries: [
      {
        id: "open",
        slot: "frockbot.sidebar-actions",
        ...(entryOrder === undefined ? {} : { order: entryOrder }),
        label: packageId,
        icon: "applets",
        opens: { kind: "surface", page: pageId },
      },
    ],
    declaredTools: ["applet_focus"],
  };
}

function catalog(
  contributions: PackageIframeContributionViewV1[],
): PackageIframeCatalogV1 {
  return {
    schemaVersion: 1,
    botId: "bot-1",
    generationId: "generation-1",
    artifactOrigin: "https://ui.example.com",
    contributions,
  };
}

describe("declarative Package entries", () => {
  test("orders entries by their declared order, above Connectors at 10", () => {
    const entries = packageIframeEntriesV1(
      catalog([
        contribution("later", 20, "later"),
        contribution("applets", 5),
        contribution("middle", 8, "middle"),
      ]),
    );
    expect(entries.map((entry) => entry.contribution.packageId)).toEqual([
      "applets",
      "middle",
      "later",
    ]);
    // Order is the whole contract of this slot: a Package that asks for 5
    // draws above one that asks for 10, whatever either of them is.
    expect(entries[0]!.order).toBe(5);
    expect(entries[0]!.order).toBeLessThan(10);
    expect(entries[2]!.order).toBeGreaterThan(10);
  });

  test("an entry with no order takes the default and ties break on Package id", () => {
    const entries = packageIframeEntriesV1(
      catalog([
        contribution("zulu", undefined, "zulu"),
        contribution("alpha", undefined, "alpha"),
      ]),
    );
    expect(entries.map((entry) => entry.contribution.packageId)).toEqual([
      "alpha",
      "zulu",
    ]);
    expect(entries[0]!.order).toBe(PACKAGE_IFRAME_ENTRY_DEFAULT_ORDER_V1);
  });

  test("an entry names the page it opens and the surface that hosts it", () => {
    const [entry] = packageIframeEntriesV1(
      catalog([contribution("applets", 5)]),
    );
    expect(entry!.page.id).toBe("list");
    expect(entry!.slot).toBe("frockbot.surface:list");
    expect(entry!.surfaceId).toBe(packageIframeSurfaceIdV1("applets", "list"));
  });

  test("no catalog is no entries rather than a failure", () => {
    expect(packageIframeEntriesV1(undefined)).toEqual([]);
  });

  test("the right-panel slot resolves the page the canvas hosts", () => {
    const pages = packageIframePagesForSlotV1(
      catalog([contribution("applets", 5)]),
      "frockbot.right-panel",
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page.id).toBe("canvas");
    expect(
      packageIframePagesForSlotV1(undefined, "frockbot.right-panel"),
    ).toEqual([]);
  });
});
