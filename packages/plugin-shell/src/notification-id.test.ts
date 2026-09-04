import { describe, expect, test } from "bun:test";

import { notificationIdV1 } from "./notification-id.js";
import { decodeClientNotificationAcknowledgementCommandV1 } from "./run-protocol.js";

/** What the acknowledge endpoint does with an id a notification carried. */
function acknowledge(notificationId: string): string {
  return decodeClientNotificationAcknowledgementCommandV1({
    schemaVersion: 1,
    action: "acknowledge",
    notificationId,
  }).notificationId;
}

describe("notificationIdV1", () => {
  test("a Composition failure id round-trips through acknowledgement", () => {
    // The shape that 400'd forever: a generation id is `<ISO instant>:<hash>`,
    // and the acknowledge decoder admits no colons.
    const id = notificationIdV1(
      "composition-failure",
      "2026-09-03T23:49:00.416Z:dc03a32d9b717619",
      1,
    );
    expect(id).not.toContain(":");
    expect(acknowledge(id)).toBe(id);
  });

  test("every minted id shape acknowledges", () => {
    const minted = [
      notificationIdV1("package-connection-unavailable", crypto.randomUUID(), "aud-usd", "gmail"),
      notificationIdV1("package", "aud-usd", "rate:moved"),
      notificationIdV1("routine-failed", "2026-09-03T23:49:00.416Z:fire"),
      notificationIdV1("task-settled", crypto.randomUUID()),
      notificationIdV1("routine-wake", crypto.randomUUID()),
    ];
    for (const id of minted) expect(acknowledge(id)).toBe(id);
  });

  test("the same parts mint the same id, so a retry is one intent", () => {
    const parts = ["composition-failure", "2026-09-03T23:49:00.416Z:abc", 2] as const;
    expect(notificationIdV1(...parts)).toBe(notificationIdV1(...parts));
  });

  test("distinct parts stay distinct, even past the length ceiling", () => {
    const long = "x".repeat(400);
    const a = notificationIdV1("package", long, "one");
    const b = notificationIdV1("package", long, "two");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(acknowledge(a)).toBe(a);
    expect(acknowledge(b)).toBe(b);
  });

  test("parts that sanitize to nothing still mint an acknowledgeable id", () => {
    const id = notificationIdV1(":::", "::");
    expect(acknowledge(id)).toBe(id);
  });
});
