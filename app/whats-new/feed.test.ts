import { describe, expect, test } from "bun:test";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import { projectWhatsNewEntryV1, whatsNewFeedV1 } from "./feed.ts";
import { whatsNewMediaBytesV1 } from "./media.ts";

describe("What’s New feed", () => {
  test("the Worker barrel does not load the review-surface file URL", async () => {
    const barrel = await import("./index.ts");
    expect("WHATS_NEW_PREVIEW_PATH_V1" in barrel).toBe(false);
  });

  test("the first shipped entry is What’s New itself", () => {
    const feed = whatsNewFeedV1();
    expect(feed.schemaVersion).toBe(1);
    expect(feed.entries[0]).toMatchObject({
      id: "whats-new",
      title: "What’s New in the app",
      kind: "feature",
      image: {
        src: "/whats-new/whats-new.webp",
        alt: "The What’s New page, with this feature as its first entry.",
      },
    });
    expect(feed.entries[0]?.publishedAt).toBeUndefined();
    expect(feed.entries[0]?.summary).toBe("What landed in each release.");
  });

  test("a known production day is attached without inventing one", () => {
    const dated = whatsNewFeedV1((id) =>
      id === "whats-new" ? "2026-09-21" : undefined,
    );
    expect(dated.entries[0]?.publishedAt).toBe("2026-09-21");
  });

  test("every declared image is on disk", () => {
    for (const entry of WHATS_NEW_ENTRIES_V1) {
      if (!entry.image) continue;
      const bytes = whatsNewMediaBytesV1(entry.image.file);
      expect(bytes, `${entry.id} is missing ${entry.image.file}`).toBeDefined();
      expect((bytes?.byteLength ?? 0) > 0).toBe(true);
    }
  });

  test("refuses a broken entry rather than shipping it", () => {
    expect(() =>
      projectWhatsNewEntryV1({
        id: "Bad Id",
        title: "X",
        summary: "Y",
        kind: "feature",
      }),
    ).toThrow(/slug/);
    expect(() =>
      projectWhatsNewEntryV1({
        id: "ok",
        title: "X",
        summary: "Y",
        kind: "feature",
        image: { file: "ok.png", alt: "A picture" },
      }),
    ).toThrow(/invalid image/);
    expect(() =>
      whatsNewFeedV1(undefined, [
        {
          id: "dup",
          title: "One",
          summary: "First",
          kind: "fix",
        },
        {
          id: "dup",
          title: "Two",
          summary: "Second",
          kind: "fix",
        },
      ]),
    ).toThrow(/duplicated/);
  });
});
