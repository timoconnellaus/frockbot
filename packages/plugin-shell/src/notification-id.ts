import { isPublicIdentifier } from "@frockbot/configuration-core";

/**
 * The acknowledge decoder's ceiling: `isPublicIdentifier` admits a leading
 * alphanumeric plus at most 127 more characters.
 */
const MAX_NOTIFICATION_ID_LENGTH = 128;

/** How much of a folded id the digest suffix costs: `-` plus eight hex. */
const DIGEST_SUFFIX_LENGTH = 9;

/**
 * A notification is only useful if it can be acknowledged, and acknowledgement
 * decodes the id through `isPublicIdentifier`
 * (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`) — which admits no colons. Delivery
 * only bounds the length, so an id minted by hand out of a generation id
 * (`2026-09-03T23:49:00.416Z:dc03a32d9b717619`) or a package request went out,
 * came back, and was refused with `400` on every poll for the life of the Bot.
 *
 * Every notification id is minted here instead, so the two sides cannot drift:
 * the parts are joined with `-`, anything outside the admitted alphabet
 * becomes `-`, and an over-long id keeps its readable head and folds the rest
 * into a digest so distinct inputs stay distinct ids. Ids are stable for the
 * same parts, which is what makes one firing one intent however many times a
 * retry re-mints it.
 */
export function notificationIdV1(
  ...parts: readonly (string | number)[]
): string {
  const raw = parts.map((part) => String(part)).join("-");
  const sanitized = raw
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "");
  const seeded = sanitized.length === 0 ? `notification-${digest(raw)}` : sanitized;
  const bounded =
    seeded.length <= MAX_NOTIFICATION_ID_LENGTH
      ? seeded
      : `${seeded.slice(0, MAX_NOTIFICATION_ID_LENGTH - DIGEST_SUFFIX_LENGTH)}-${digest(raw)}`;
  if (!isPublicIdentifier(bounded)) {
    // Unreachable by construction; a mint that cannot be acknowledged is a
    // bug, never something to ship to a client that will 400 on it forever.
    throw new Error(`minted notification id "${bounded}" is not acknowledgeable`);
  }
  return bounded;
}

/** FNV-1a, eight hex digits — an id disambiguator, not a security claim. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
