/**
 * Which notification intents this browser has already shown.
 *
 * "One notification per message" is a promise about the *person*, not about
 * the page. The durable acknowledgement the Bot records is what closes an
 * intent, but it lands after the notification is shown, and in that window a
 * second tab polling the same fan-out — or the same tab after a reload —
 * showed the identical intent again. A set on the page could not see either.
 *
 * `localStorage` can, because both tabs of one browser share it. It is a
 * ledger of ids, never of content: an id already here is one this browser has
 * spoken. It is bounded and oldest-first, so a long-lived session cannot grow
 * it without limit; an id that falls off the end is one whose acknowledgement
 * settled long ago.
 */

export const DELIVERED_NOTIFICATIONS_KEY =
  "frockbot.flock.delivered-notifications.v1";

/** How many ids one browser remembers. Comfortably past any in-flight burst. */
export const DELIVERED_NOTIFICATIONS_LIMIT = 200;

type WritableStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A browser with storage denied still shows notifications; it only loses
    // the cross-tab half of the promise.
    return undefined;
  }
}

/** The key one intent is remembered under. */
export function deliveredNotificationKeyV1(
  botId: string,
  notificationId: string,
): string {
  return `${botId}:${notificationId}`;
}

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Claims the right to show the intent behind `key`, returning `false` when
 * some other tab — or this one, before a reload — already has it.
 *
 * Check-and-write in one call, and the write happens *before* the notification
 * is shown, because the gap between showing and recording is exactly where the
 * duplicate got in.
 */
export function claimNotificationDeliveryV1(
  key: string,
  storage: WritableStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return true;
  try {
    const existing = parse(storage.getItem(DELIVERED_NOTIFICATIONS_KEY));
    if (existing.includes(key)) return false;
    const next = [...existing, key].slice(-DELIVERED_NOTIFICATIONS_LIMIT);
    storage.setItem(DELIVERED_NOTIFICATIONS_KEY, JSON.stringify(next));
    return true;
  } catch {
    // Storage that will not take the ledger must not silence the notification.
    return true;
  }
}

/**
 * Gives a claim back, for the one case where the notification was never
 * actually shown: no permission yet. Without this the intent would be
 * remembered as spoken and stay silent after the User granted it.
 */
export function releaseNotificationDeliveryV1(
  key: string,
  storage: WritableStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    const existing = parse(storage.getItem(DELIVERED_NOTIFICATIONS_KEY));
    if (!existing.includes(key)) return;
    storage.setItem(
      DELIVERED_NOTIFICATIONS_KEY,
      JSON.stringify(existing.filter((entry) => entry !== key)),
    );
  } catch {
    // Nothing to undo that anybody can see.
  }
}
