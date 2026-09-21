/**
 * The calendar day a What’s New entry became available: the first production
 * tag that contains it, not the pull request’s merge day.
 *
 * A prerelease tag is not a ship. Missing tags mean the entry is in this
 * Worker but has not been dated yet — the client says “New” rather than
 * inventing a day.
 */

import { WHATS_NEW_PUBLISHED_AT_V1 } from "./dates.generated.ts";

const PRODUCTION_TAG_V1 = /^v(\d+)\.(\d+)\.(\d+)$/;

export function isProductionReleaseTagV1(tag: string): boolean {
  return PRODUCTION_TAG_V1.test(tag);
}

export function compareProductionReleaseTagsV1(
  left: string,
  right: string,
): number {
  const a = PRODUCTION_TAG_V1.exec(left);
  const b = PRODUCTION_TAG_V1.exec(right);
  if (!a || !b) {
    throw new Error("compareProductionReleaseTagsV1 requires vX.Y.Z tags");
  }
  for (const index of [1, 2, 3]) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** UTC calendar day `YYYY-MM-DD` from an instant, or undefined when unparseable. */
export function utcCalendarDayV1(instant: string): string | undefined {
  const stamp = Date.parse(instant);
  if (!Number.isFinite(stamp)) return undefined;
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * The date of the earliest production tag in [tags], looked up in [dates].
 * [tags] may include prereleases; they are ignored.
 */
export function earliestProductionTagDateV1(
  tags: readonly string[],
  dates: Readonly<Record<string, string>>,
): string | undefined {
  const production = tags.filter(isProductionReleaseTagV1);
  if (production.length === 0) return undefined;
  const ordered = [...production].sort(compareProductionReleaseTagsV1);
  const instant = dates[ordered[0]!];
  return instant === undefined ? undefined : utcCalendarDayV1(instant);
}

/** Ids declared in an `entries.ts` source snapshot, in file order. */
export function whatsNewEntryIdsInSourceV1(source: string): string[] {
  return [
    ...source.matchAll(/^\s*id:\s*"([a-z0-9][a-z0-9-]{0,63})",?\s*$/gm),
  ].map((match) => match[1]!);
}

/** Ship day for each id that has one, from the tags that contain it. */
export function whatsNewPublishedAtByIdV1(
  tagsById: Readonly<Record<string, readonly string[]>>,
  tagDates: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const published: Record<string, string> = {};
  for (const id of Object.keys(tagsById).sort()) {
    const day = earliestProductionTagDateV1(tagsById[id] ?? [], tagDates);
    if (day) published[id] = day;
  }
  return published;
}

/** The first production tag that shipped [id], when generate has recorded one. */
export function whatsNewPublishedAtV1(id: string): string | undefined {
  return WHATS_NEW_PUBLISHED_AT_V1[id];
}
