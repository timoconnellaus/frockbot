/**
 * One place the whole client turns a durable ISO moment into something a
 * person reads.
 *
 * Every durable record carries UTC ISO text, because that is the only form two
 * machines can agree on. A person reading the panel is not two machines: they
 * want the moment in their own day. Panels used to render the ISO string
 * verbatim — "Next run 2026-09-03T12:08:28.834Z" — which is precise and
 * unreadable, and the one panel that did format dates picked the US order for
 * an Australian reader. So this module, and nothing else, decides the shape.
 */

const DEFAULT_LOCALE = "en-AU";

/** The reader's own zone, or UTC where the environment will not say. */
export function browserTimeZoneV1(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export interface UiMomentOptionsV1 {
  /** The zone to read the moment in. Defaults to the reader's own. */
  timeZone?: string;
  /** Locale override, for tests. */
  locale?: string;
}

function parts(
  iso: string,
  options: UiMomentOptionsV1,
  shape: Intl.DateTimeFormatOptions,
): string | undefined {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  try {
    return new Intl.DateTimeFormat(options.locale ?? DEFAULT_LOCALE, {
      ...shape,
      timeZone: options.timeZone ?? browserTimeZoneV1(),
    }).format(new Date(parsed));
  } catch {
    return undefined;
  }
}

/** `9:30am`, lowercase, no leading zero on the hour. */
export function formatTimeOfDayV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  const formatted = parts(iso, options, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (formatted === undefined) return iso;
  return formatted.replace(/\s*(AM|PM|am|pm)$/u, (_match, marker: string) =>
    marker.toLowerCase(),
  );
}

/** `3 Sep 2026` — day first, never the US month-first order. */
export function formatDayV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  return (
    parts(iso, options, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) ?? iso
  );
}

/**
 * `3 Sep 2026, 9:30am`. An unparseable value is returned untouched rather than
 * rendered as "Invalid Date": the durable text is at least true.
 */
export function formatMomentV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return `${formatDayV1(iso, options)}, ${formatTimeOfDayV1(iso, options)}`;
}

/**
 * A moment relative to now while that is the more useful reading, and the
 * absolute one after. A run log is scanned for "did it just fire?"; a run from
 * last month is scanned for which day it was.
 */
export function formatRelativeMomentV1(
  iso: string,
  options: UiMomentOptionsV1 & { now?: Date } = {},
): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const now = (options.now ?? new Date()).getTime();
  const elapsed = now - parsed;
  if (elapsed < 0) return formatMomentV1(iso, options);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return `${minutes} min ago`;
  }
  if (elapsed < 86_400_000) {
    const hours = Math.floor(elapsed / 3_600_000);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  return formatMomentV1(iso, options);
}
