import { describe, expect, test } from "bun:test";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import { projectWhatsNewEntryV1, whatsNewFeedV1 } from "./feed.ts";
import { whatsNewMediaBytesV1 } from "./media.ts";

describe("What’s New feed", () => {
  test("newest first, and What’s New stays in the list", () => {
    const feed = whatsNewFeedV1();
    expect(feed.schemaVersion).toBe(1);
    expect(feed.entries[0]).toMatchObject({
      id: "voice-opening",
      title: "The first words of a call are kept",
      kind: "improvement",
    });
    expect(feed.entries[1]).toMatchObject({
      id: "committed-chat",
      title: "Replies land as they are sent",
      kind: "improvement",
    });
    expect(feed.entries[2]).toMatchObject({
      id: "chat-scroll",
      title: "Earlier messages stay in reach",
      kind: "fix",
    });
    expect(feed.entries[3]).toMatchObject({
      id: "marketplace-installed",
      title: "Installed in the Marketplace",
      kind: "improvement",
    });
    expect(feed.entries[4]).toMatchObject({
      id: "chat-type",
      title: "Easier reading in chat",
      kind: "improvement",
      image: {
        src: "/whats-new/chat-type.webp",
        alt: "A Bot message in Inter, with air between list items.",
      },
    });
    const shipped = feed.entries.find((entry) => entry.id === "whats-new");
    expect(shipped).toMatchObject({
      id: "whats-new",
      title: "What’s New in the app",
      kind: "feature",
      summary: "What landed in each release.",
    });
    expect(feed.entries[0]?.publishedAt).toBeUndefined();
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
