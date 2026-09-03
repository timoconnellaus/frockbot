/**
 * Declarative Package entries.
 *
 * An entry is manifest data — an id, a label, an icon name, and the page it
 * opens — so a Package puts a control in the shell's sidebar without shipping
 * a line of JavaScript into the app origin. This module turns the catalog into
 * the ordered list the shell registers, and nothing here executes Package
 * code.
 */
import type {
  PackageIframeCatalogV1,
  PackageIframeContributionViewV1,
  PackageIframeEntryViewV1,
  PackageIframePageViewV1,
} from "@frockbot/kernel-contracts";

export interface PackageIframeEntryV1 {
  contribution: PackageIframeContributionViewV1;
  entry: PackageIframeEntryViewV1;
  page: PackageIframePageViewV1;
  /** The slot the page is mounted in when the entry opens it. */
  slot: string;
  /** The shell surface id this entry opens. Stable for one Package page. */
  surfaceId: string;
  /** Where the entry sits among the slot's other fillers. */
  order: number;
}

/** The order a Package entry takes when its manifest names none. */
export const PACKAGE_IFRAME_ENTRY_DEFAULT_ORDER_V1 = 50;

export function packageIframeSurfaceIdV1(
  packageId: string,
  pageId: string,
): string {
  return `package-page:${packageId}:${pageId}`;
}

export function packageIframePageSlotV1(pageId: string): string {
  return `frockbot.surface:${pageId}`;
}

/**
 * Every entry the Bot's active Composition declares, in the order the sidebar
 * draws them. Ties break on Package id so two Packages asking for the same
 * order draw in a stable sequence rather than in catalog order.
 */
export function packageIframeEntriesV1(
  catalog: PackageIframeCatalogV1 | undefined,
): PackageIframeEntryV1[] {
  return (catalog?.contributions ?? [])
    .flatMap((contribution) =>
      contribution.entries.flatMap((entry) => {
        const page = contribution.pages.find(
          (candidate) => candidate.id === entry.opens.page,
        );
        // The catalog decoder already refuses an entry whose page does not
        // mount its own surface slot; this keeps the projection total anyway,
        // because a shell that renders half an entry is worse than one that
        // renders none.
        if (!page) return [];
        return [
          {
            contribution,
            entry,
            page,
            slot: packageIframePageSlotV1(page.id),
            surfaceId: packageIframeSurfaceIdV1(
              contribution.packageId,
              page.id,
            ),
            order: entry.order ?? PACKAGE_IFRAME_ENTRY_DEFAULT_ORDER_V1,
          },
        ];
      }),
    )
    .toSorted(
      (left, right) =>
        left.order - right.order ||
        left.contribution.packageId.localeCompare(
          right.contribution.packageId,
        ) ||
        left.entry.id.localeCompare(right.entry.id),
    );
}

/**
 * The pages mounted in one slot, in mount order. The right panel and the
 * settings screen both read their pages this way.
 */
export function packageIframePagesForSlotV1(
  catalog: PackageIframeCatalogV1 | undefined,
  slot: string,
): Array<{
  contribution: PackageIframeContributionViewV1;
  page: PackageIframePageViewV1;
  order: number;
}> {
  return (catalog?.contributions ?? [])
    .flatMap((contribution) =>
      contribution.pages.flatMap((page) =>
        page.mounts
          .filter((mount) => mount.slot === slot)
          .map((mount) => ({ contribution, page, order: mount.order ?? 0 })),
      ),
    )
    .toSorted(
      (left, right) =>
        left.order - right.order ||
        left.contribution.packageId.localeCompare(right.contribution.packageId),
    );
}
