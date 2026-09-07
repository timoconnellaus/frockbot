// The first-party Package pages the shell serves, and what each may do.
//
// A Bot-authored Package's pages arrive as immutable artifacts named by a
// Composition member's manifest, and the shell checks the Composition
// generation before it will run a tool one of them names. A first-party page is
// not a Composition member and never becomes stale against one: it ships in
// this bundle, so this list *is* the declaration. There is no generation to
// check and nothing to look up in a manifest.
//
// What a page may do is still declared, and still enforced by the shell rather
// than trusted from the page: `tools` is the closed set of tool names a page of
// this Package may call across the iframe bridge. The bridge protocol itself is
// unchanged — it is the page contract a Bot-authored page will reuse.
import type { PackageIframeEntryViewV1 } from "@frockbot/kernel-contracts";
import { APPLETS_PAGE_SOURCES_V1 } from "./pages.generated.js";

export interface FirstPartyPackagePageV1 {
  packageId: string;
  pageId: string;
  /** sha-256 of the html, which is also the path the page origin serves it at. */
  contentHash: string;
  size: number;
  html: string;
  /** The tool names a page of this Package may call across the bridge. */
  tools: readonly string[];
  /** Where the shell mounts this page. */
  mounts: readonly { slot: string; order?: number }[];
}

export interface FirstPartyPackageUiV1 {
  packageId: string;
  displayName: string;
  pages: readonly FirstPartyPackagePageV1[];
  /** Declarative launchers, in the sidebar. */
  entries: readonly PackageIframeEntryViewV1[];
}

/** What each page may do, and where it is shown. */
const APPLETS_PAGES_V1: ReadonlyMap<
  string,
  Pick<FirstPartyPackagePageV1, "tools" | "mounts">
> = new Map([
  [
    "list",
    {
      // Focus is an Applet capability, and the shell gates the `focus` bridge
      // message on this exact name.
      tools: ["applet_focus"],
      mounts: [{ slot: "frockbot.surface:list" }],
    },
  ],
  ["canvas", { tools: [], mounts: [{ slot: "frockbot.right-panel" }] }],
]);

function appletsPages(): FirstPartyPackagePageV1[] {
  return APPLETS_PAGE_SOURCES_V1.map((source) => {
    const declared = APPLETS_PAGES_V1.get(source.pageId);
    if (!declared) {
      throw new Error(`the Applets page "${source.pageId}" is not declared`);
    }
    return {
      packageId: "applets",
      pageId: source.pageId,
      contentHash: source.contentHash,
      size: source.size,
      html: source.html,
      tools: declared.tools,
      mounts: declared.mounts,
    };
  });
}

/** Every first-party Package page, and the Packages that own them. */
export const FIRST_PARTY_PACKAGE_UI_V1: readonly FirstPartyPackageUiV1[] = [
  {
    packageId: "applets",
    displayName: "Applets",
    pages: appletsPages(),
    entries: [
      {
        id: "open",
        slot: "frockbot.sidebar-actions",
        order: 5,
        label: "Applets",
        icon: "applets",
        opens: { kind: "surface", page: "list" },
      },
    ],
  },
];

/**
 * Every first-party page by the path the anonymous page origin serves it at.
 *
 * The store reads `packages/<hash>.html` from object storage first and falls
 * back to this map, so a first-party page needs no deploy step of its own and
 * behaves identically in production, in dev, in workerd, and in e2e.
 */
export const FIRST_PARTY_PACKAGE_ARTIFACTS_V1: ReadonlyMap<string, string> =
  new Map(
    FIRST_PARTY_PACKAGE_UI_V1.flatMap((contribution) =>
      contribution.pages.map(
        (page) => [`packages/${page.contentHash}.html`, page.html] as const,
      ),
    ),
  );

/** Whether a page of this first-party Package may call this tool. */
export function firstPartyPackageToolAllowedV1(
  packageId: string,
  name: string,
): boolean {
  const contribution = FIRST_PARTY_PACKAGE_UI_V1.find(
    (candidate) => candidate.packageId === packageId,
  );
  return Boolean(contribution?.pages.some((page) => page.tools.includes(name)));
}
