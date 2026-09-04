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
 *
 * The shape is assembled here from numeric parts rather than taken from a
 * locale's own rendering. `Intl` is asked only for the two things it alone
 * knows — which calendar day and clock hour a UTC instant falls on in a given
 * zone — and every visible character after that is ours. It has to be: the
 * month abbreviation and the am/pm marker are CLDR data, so the same code
 * renders "3 Sep 2026" under one ICU version and "3 Sept 2026" under the next,
 * and a narrow no-break space before the marker under some builds and a plain
 * one under others. That is invisible until a test written on one machine
 * fails on another, and worse, it means two people reading the same Bot see
 * different text. A house style that varies by machine is not a house style.
 */

/** The month names this module renders. Ours, not the platform's. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * A locale chosen for one property only: it yields plain numeric parts for
 * `year`/`month`/`day`/`hour`/`minute` in every ICU build. Nothing of its
 * ordering, separators or names reaches the screen — `formatToParts` is read
 * by name and the string is rebuilt below.
 */
const PARTS_LOCALE = "en-GB";

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
}

interface MomentPartsV1 {
  day: number;
  month: number;
  year: number;
  hour: number;
  minute: number;
}

/**
 * The calendar day and clock time one UTC instant falls on in one zone.
 *
 * Read as a 24-hour clock and converted below, because `hour12` is where the
 * am/pm marker and its spacing come from, and those are exactly the parts that
 * differ between ICU builds.
 */
function momentParts(
  iso: string,
  options: UiMomentOptionsV1,
): MomentPartsV1 | undefined {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(PARTS_LOCALE, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
      timeZone: options.timeZone ?? browserTimeZoneV1(),
    }).formatToParts(new Date(parsed));
  } catch {
    return undefined;
  }
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const moment = {
    day: read("day"),
    month: read("month"),
    year: read("year"),
    // Some builds render midnight under a 24-hour clock as `24`.
    hour: read("hour") % 24,
    minute: read("minute"),
  };
  return Object.values(moment).every((value) => Number.isFinite(value))
    ? moment
    : undefined;
}

/** `9:30am`, lowercase, no leading zero on the hour. */
export function formatTimeOfDayV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  const moment = momentParts(iso, options);
  if (!moment) return iso;
  const marker = moment.hour < 12 ? "am" : "pm";
  const hour = moment.hour % 12 === 0 ? 12 : moment.hour % 12;
  return `${hour}:${String(moment.minute).padStart(2, "0")}${marker}`;
}

/** `3 Sep 2026` — day first, never the US month-first order. */
export function formatDayV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  const moment = momentParts(iso, options);
  if (!moment) return iso;
  const month = MONTHS[moment.month - 1];
  if (month === undefined) return iso;
  return `${moment.day} ${month} ${moment.year}`;
}

/**
 * `3 Sep 2026, 9:30am`. An unparseable value is returned untouched rather than
 * rendered as "Invalid Date": the durable text is at least true.
 */
export function formatMomentV1(
  iso: string,
  options: UiMomentOptionsV1 = {},
): string {
  const moment = momentParts(iso, options);
  if (!moment) return iso;
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
