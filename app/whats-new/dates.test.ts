import { describe, expect, test } from "bun:test";
import {
  compareProductionReleaseTagsV1,
  earliestProductionTagDateV1,
  isProductionReleaseTagV1,
  utcCalendarDayV1,
  whatsNewEntryIdsInSourceV1,
  whatsNewPublishedAtByIdV1,
  whatsNewPublishedAtV1,
} from "./dates.ts";
import { WHATS_NEW_PUBLISHED_AT_V1 } from "./dates.generated.ts";

describe("What’s New dates", () => {
  test("a production tag is vX.Y.Z and nothing else", () => {
    expect(isProductionReleaseTagV1("v0.8.42")).toBe(true);
    expect(isProductionReleaseTagV1("v0.8.42-rc.1")).toBe(false);
    expect(isProductionReleaseTagV1("mac-v1.2.0")).toBe(false);
  });

  test("orders production tags by version, not by string", () => {
    expect(compareProductionReleaseTagsV1("v0.9.0", "v0.10.0")).toBeLessThan(0);
    expect(compareProductionReleaseTagsV1("v1.0.0", "v0.9.9")).toBeGreaterThan(
      0,
    );
    expect(compareProductionReleaseTagsV1("v1.2.3", "v1.2.3")).toBe(0);
  });

  test("the date is the earliest production tag, not a later one or a prerelease", () => {
    expect(
      earliestProductionTagDateV1(["v0.8.51", "v0.8.50-rc.1", "v0.8.50"], {
        "v0.8.50": "2026-09-21T18:04:11.000Z",
        "v0.8.51": "2026-09-22T09:00:00.000Z",
      }),
    ).toBe("2026-09-21");
  });

  test("an entry with no production tag yet has no date", () => {
    expect(
      earliestProductionTagDateV1(["v0.8.50-rc.1"], {
        "v0.8.50-rc.1": "2026-09-20T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  test("the displayed day is UTC, so a late-evening merge does not shift the calendar", () => {
    expect(utcCalendarDayV1("2026-09-21T23:15:00.000Z")).toBe("2026-09-21");
    expect(utcCalendarDayV1("not a date")).toBeUndefined();
  });

  test("ids come from the catalog source, not from a guessed merge commit", () => {
    expect(
      whatsNewEntryIdsInSourceV1(`
export const WHATS_NEW_ENTRIES_V1 = [
  {
    id: "newer",
    title: "B",
  },
  {
    id: "older",
    title: "A",
  },
];
`),
    ).toEqual(["newer", "older"]);
  });

  test("each id takes the earliest production tag that contains it", () => {
    expect(
      whatsNewPublishedAtByIdV1(
        {
          search: ["v0.8.51", "v0.8.50-rc.1"],
          "whats-new": ["v0.8.50", "v0.8.51"],
        },
        {
          "v0.8.50": "2026-09-21T18:04:11.000Z",
          "v0.8.51": "2026-09-22T09:00:00.000Z",
        },
      ),
    ).toEqual({
      search: "2026-09-22",
      "whats-new": "2026-09-21",
    });
  });

  test("the Worker lookup is the generated map, not a live git scan", () => {
    expect(whatsNewPublishedAtV1("whats-new")).toBe(
      WHATS_NEW_PUBLISHED_AT_V1["whats-new"],
    );
    expect(whatsNewPublishedAtV1("not-an-entry")).toBeUndefined();
  });
});
