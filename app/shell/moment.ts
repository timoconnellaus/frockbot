/**
 * How long ago something happened, for a surface that only needs the distance
 * and not the date.
 *
 * A projection cannot know the reader's zone — the phone has no IANA zone to
 * send — so an absolute moment can only be written in the zone the record
 * itself carries. A machine's last poll and a template's packing carry none,
 * and "last seen 2026-09-07T22:03:48.582Z" is the wire showing through. The
 * distance from now needs neither a zone nor a locale, and is what a person
 * reading either surface actually wants to know.
 *
 * Where a record does carry its own zone — a Routine's schedule — the absolute
 * moment is the right thing and `routineMomentV1` writes it.
 */
export function agoV1(iso: string, now: string): string {
  const then = new Date(iso).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(at)) return iso;
  const seconds = Math.round((at - then) / 1000);
  // A clock ahead of the server's is a fact about the clocks, not about when
  // the thing happened, so it reads as the present rather than as the future.
  if (seconds < 45) return "just now";
  for (const [limit, unit, size] of [
    [3600, "minute", 60],
    [86_400, "hour", 3600],
    [2_592_000, "day", 86_400],
  ] as const) {
    if (seconds < limit) {
      const count = Math.round(seconds / size);
      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  const months = Math.round(seconds / 2_592_000);
  return months < 12
    ? `${months} month${months === 1 ? "" : "s"} ago`
    : "over a year ago";
}
