import { describe, expect, test } from "bun:test";
import { orderWhatsNewEntriesV1, WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import { projectWhatsNewEntryV1, whatsNewFeedV1 } from "./feed.ts";
import { whatsNewMediaBytesV1 } from "./media.ts";

describe("What’s New feed", () => {
  test("newest first by when each entry was written", () => {
    const feed = whatsNewFeedV1();
    expect(feed.schemaVersion).toBe(1);
    expect(feed.entries.map((entry) => entry.id)).toEqual(
      WHATS_NEW_ENTRIES_V1.map((entry) => entry.id),
    );
    for (const [index, entry] of WHATS_NEW_ENTRIES_V1.entries()) {
      expect(entry.added, entry.id).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      const next = WHATS_NEW_ENTRIES_V1[index + 1];
      if (next) expect(entry.added >= next.added, entry.id).toBe(true);
    }
  });

  test("an entry written later sorts first; a tie falls back to the id", () => {
    const entry = (id: string, added: string) => ({
      id,
      added,
      title: "T",
      summary: "S",
      kind: "fix" as const,
    });
    expect(
      orderWhatsNewEntriesV1([
        entry("b", "2026-09-01T00:00:00Z"),
        entry("c", "2026-09-02T00:00:00Z"),
        entry("a", "2026-09-01T00:00:00Z"),
      ]).map((value) => value.id),
    ).toEqual(["c", "a", "b"]);
  });

  test("the feed carries each entry’s copy and still, and never its added instant", () => {
    const feed = whatsNewFeedV1();
    const shipped = feed.entries.find((entry) => entry.id === "whats-new");
    expect(shipped).toEqual({
      id: "whats-new",
      title: "What’s New in the app",
      summary: "What landed in each release.",
      kind: "feature",
      image: {
        src: "/whats-new/whats-new.webp",
        alt: "The What’s New page, with this feature as its first entry.",
      },
    });
    expect(
      feed.entries.find((entry) => entry.id === "voice-answers-after-tools"),
    ).toMatchObject({ kind: "fix" });
    expect(feed.entries.every((entry) => entry.publishedAt === undefined)).toBe(
      true,
    );
  });

  test("a known production day is attached without inventing one", () => {
    const dated = whatsNewFeedV1((id) =>
      id === "whats-new" ? "2026-09-21" : undefined,
    );
    expect(
      dated.entries.find((entry) => entry.id === "whats-new")?.publishedAt,
    ).toBe("2026-09-21");
    expect(
      dated.entries.find((entry) => entry.id === "chat-type")?.publishedAt,
    ).toBeUndefined();
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
