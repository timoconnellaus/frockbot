import { expect, test } from "bun:test";
import { agoV1 } from "./moment.js";

const now = "2026-09-06T12:00:00.000Z";

test("a distance, in the largest unit that still says something", () => {
  expect(agoV1("2026-09-06T11:59:40.000Z", now)).toBe("just now");
  expect(agoV1("2026-09-06T11:58:00.000Z", now)).toBe("2 minutes ago");
  expect(agoV1("2026-09-06T11:59:00.000Z", now)).toBe("1 minute ago");
  expect(agoV1("2026-09-06T09:00:00.000Z", now)).toBe("3 hours ago");
  expect(agoV1("2026-09-04T12:00:00.000Z", now)).toBe("2 days ago");
  expect(agoV1("2026-07-06T12:00:00.000Z", now)).toBe("2 months ago");
  expect(agoV1("2024-07-06T12:00:00.000Z", now)).toBe("over a year ago");
});

test("a clock ahead of the server's reads as the present, not the future", () => {
  expect(agoV1("2026-09-06T12:05:00.000Z", now)).toBe("just now");
});

test("an instant that will not parse is shown as it stands", () => {
  expect(agoV1("not a time", now)).toBe("not a time");
});
