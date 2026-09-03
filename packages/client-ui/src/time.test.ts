import { describe, expect, test } from "bun:test";
import {
  browserTimeZoneV1,
  formatDayV1,
  formatMomentV1,
  formatRelativeMomentV1,
  formatTimeOfDayV1,
} from "./time.js";

const SYDNEY = { timeZone: "Australia/Sydney", locale: "en-AU" } as const;

describe("formatMomentV1", () => {
  test("renders a durable ISO moment in the reader's zone, day first", () => {
    // The panel used to render this exact string verbatim.
    expect(formatMomentV1("2026-09-03T12:08:28.834Z", SYDNEY)).toBe(
      "3 Sep 2026, 10:08pm",
    );
  });

  test("never renders the US month-first order", () => {
    const formatted = formatMomentV1("2026-09-03T11:59:51.000Z", SYDNEY);
    expect(formatted).not.toContain("9/3/2026");
    expect(formatted.startsWith("3 Sep 2026")).toBe(true);
  });

  test("returns unparseable text untouched rather than 'Invalid Date'", () => {
    expect(formatMomentV1("not a moment", SYDNEY)).toBe("not a moment");
    expect(formatRelativeMomentV1("", SYDNEY)).toBe("");
  });
});

describe("formatTimeOfDayV1", () => {
  test("is 12-hour with a lowercase marker and no leading zero", () => {
    expect(formatTimeOfDayV1("2026-09-03T23:30:00.000Z", SYDNEY)).toBe(
      "9:30am",
    );
    expect(formatTimeOfDayV1("2026-09-03T04:05:00.000Z", SYDNEY)).toBe(
      "2:05pm",
    );
  });
});

describe("formatDayV1", () => {
  test("abbreviates the month", () => {
    expect(formatDayV1("2026-09-03T12:00:00.000Z", SYDNEY)).toBe("3 Sep 2026");
  });
});

describe("formatRelativeMomentV1", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");

  test("reads a fresh run relatively and an old one absolutely", () => {
    expect(
      formatRelativeMomentV1("2026-09-03T11:59:30.000Z", { ...SYDNEY, now }),
    ).toBe("just now");
    expect(
      formatRelativeMomentV1("2026-09-03T11:45:00.000Z", { ...SYDNEY, now }),
    ).toBe("15 min ago");
    expect(
      formatRelativeMomentV1("2026-09-03T09:00:00.000Z", { ...SYDNEY, now }),
    ).toBe("3 hours ago");
    expect(
      formatRelativeMomentV1("2026-08-30T09:00:00.000Z", { ...SYDNEY, now }),
    ).toBe("30 Aug 2026, 7:00pm");
  });

  test("a future moment is absolute — 'in a while' is not a next run", () => {
    expect(
      formatRelativeMomentV1("2026-09-03T12:30:00.000Z", { ...SYDNEY, now }),
    ).toBe("3 Sep 2026, 10:30pm");
  });
});

describe("browserTimeZoneV1", () => {
  test("names a zone the form can default to", () => {
    expect(browserTimeZoneV1().length).toBeGreaterThan(0);
  });
});
