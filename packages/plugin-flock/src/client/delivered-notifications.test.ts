import { describe, expect, test } from "bun:test";
import {
  claimNotificationDeliveryV1,
  deliveredNotificationKeyV1,
  DELIVERED_NOTIFICATIONS_KEY,
  DELIVERED_NOTIFICATIONS_LIMIT,
  releaseNotificationDeliveryV1,
} from "./delivered-notifications.js";

/** The half of `localStorage` the ledger uses, shared as a browser shares it. */
function storage(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>(
    initial === undefined ? [] : [[DELIVERED_NOTIFICATIONS_KEY, initial]],
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("the delivered-notification ledger", () => {
  test("the first claim wins and every later one loses", () => {
    const shared = storage();
    const key = deliveredNotificationKeyV1("beta", "run-1");
    expect(claimNotificationDeliveryV1(key, shared)).toBe(true);
    expect(claimNotificationDeliveryV1(key, shared)).toBe(false);
    // A second tab reads the same storage, so it loses too — which is the
    // whole point: one notification per message, not one per tab.
    expect(claimNotificationDeliveryV1(key, shared)).toBe(false);
    // A different message is still news.
    expect(
      claimNotificationDeliveryV1(
        deliveredNotificationKeyV1("beta", "run-2"),
        shared,
      ),
    ).toBe(true);
  });

  test("a claim survives the reload that empties the page's own set", () => {
    const values = new Map<string, string>();
    const persistent = (): Pick<Storage, "getItem" | "setItem"> => ({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    });
    const key = deliveredNotificationKeyV1("beta", "run-1");
    expect(claimNotificationDeliveryV1(key, persistent())).toBe(true);
    // A brand-new page, the same browser.
    expect(claimNotificationDeliveryV1(key, persistent())).toBe(false);
  });

  test("a notification that could not be shown gives its claim back", () => {
    const shared = storage();
    const key = deliveredNotificationKeyV1("beta", "run-1");
    expect(claimNotificationDeliveryV1(key, shared)).toBe(true);
    releaseNotificationDeliveryV1(key, shared);
    expect(claimNotificationDeliveryV1(key, shared)).toBe(true);
  });

  test("the ledger is bounded, oldest first", () => {
    const shared = storage();
    for (let index = 0; index <= DELIVERED_NOTIFICATIONS_LIMIT; index += 1) {
      claimNotificationDeliveryV1(
        deliveredNotificationKeyV1("beta", `run-${index}`),
        shared,
      );
    }
    // The oldest fell off; the newest is still remembered.
    expect(
      claimNotificationDeliveryV1(
        deliveredNotificationKeyV1("beta", "run-0"),
        shared,
      ),
    ).toBe(true);
    expect(
      claimNotificationDeliveryV1(
        deliveredNotificationKeyV1(
          "beta",
          `run-${DELIVERED_NOTIFICATIONS_LIMIT}`,
        ),
        shared,
      ),
    ).toBe(false);
  });

  test("junk in storage is not a reason to go silent", () => {
    for (const junk of ["", "{", "null", '{"not":"an array"}', "[1,2,3]"]) {
      const key = deliveredNotificationKeyV1("beta", "run-1");
      const shared = storage(junk);
      expect(claimNotificationDeliveryV1(key, shared)).toBe(true);
      expect(claimNotificationDeliveryV1(key, shared)).toBe(false);
    }
  });

  test("no storage at all still shows the notification", () => {
    const key = deliveredNotificationKeyV1("beta", "run-1");
    expect(claimNotificationDeliveryV1(key, undefined)).toBe(true);
    expect(claimNotificationDeliveryV1(key, undefined)).toBe(true);
  });
});
