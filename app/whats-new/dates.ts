/**
 * The calendar day a What’s New entry became available: the first production
 * tag that contains it, not the pull request’s merge day.
 *
 * A prerelease tag is not a ship. Missing tags mean the entry is in this
 * Worker but has not been dated yet — the client says “New” rather than
 * inventing a day.
 */

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
