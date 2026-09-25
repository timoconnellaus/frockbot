import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  PUBLICATION_PENDING_PREFIX,
  announcementEntityIdV1,
  commitPublicationsV1,
  type PublicationTransactionV1,
  readConversationRowV1,
  readPublicationHeadV1,
  readReplayUpdatesV1,
  readVisibleIndexV1,
} from "@frockbot/core/durable";
import { cleanCompactionAnnouncementsV1 } from "./compaction-announcement-cleanup.js";

const at = "2026-09-25T00:00:00.000Z";

function rename(id: string) {
  return {
    kind: "announcement" as const,
    entityId: announcementEntityIdV1(id),
    payload: {
      announcement: {
        type: "bot/renamed",
        announcementId: id,
        at,
        from: "Scout",
        to: "Bob",
        namedBy: "user",
      },
    },
  };
}

function compaction(id: string) {
  return {
    kind: "announcement" as const,
    entityId: announcementEntityIdV1(id),
    payload: {
      announcement: {
        type: "conversation/compacted",
        announcementId: id,
        at,
        throughTurn: 4,
      },
    },
  };
}

describe("compaction announcement cleanup", () => {
  test("drops published compaction lines and the replay that carried them", async () => {
    const storage = new MemoryStorage();
    const transaction = storage as unknown as PublicationTransactionV1;
    await commitPublicationsV1(transaction, [rename("announcement-1")]);
    await commitPublicationsV1(transaction, [compaction("compaction-7")]);
    await commitPublicationsV1(transaction, [compaction("compaction-9")]);
    await commitPublicationsV1(transaction, [rename("announcement-2")]);

    await cleanCompactionAnnouncementsV1(storage);

    const index = await readVisibleIndexV1(storage);
    expect(index.announcementEntityIds).toEqual([
      "ann:announcement-1",
      "ann:announcement-2",
    ]);
    expect(
      await readConversationRowV1(storage, "ann:compaction-9"),
    ).toBeUndefined();
    expect(
      await readConversationRowV1(storage, "ann:announcement-2"),
    ).toBeDefined();

    // A client behind the trim point resets; one after it replays cleanly.
    const head = await readPublicationHeadV1(storage);
    expect(head.firstRetainedCursor).toBe(4);
    expect(head.lastCursor).toBe(4);
    const replay = await readReplayUpdatesV1(storage, head, 3);
    expect(replay.map((update) => update.entityId)).toEqual([
      "ann:announcement-2",
    ]);
    const pending = await storage.list({ prefix: PUBLICATION_PENDING_PREFIX });
    expect(
      [...pending.values()].map(
        (value) => (value as { entityId: string }).entityId,
      ),
    ).toEqual(["ann:announcement-2"]);
  });

  test("runs once, and leaves a store without compaction lines alone", async () => {
    const storage = new MemoryStorage();
    const transaction = storage as unknown as PublicationTransactionV1;
    await commitPublicationsV1(transaction, [rename("announcement-1")]);
    const before = await readPublicationHeadV1(storage);

    await cleanCompactionAnnouncementsV1(storage);
    expect(await readPublicationHeadV1(storage)).toEqual(before);

    await commitPublicationsV1(transaction, [compaction("compaction-3")]);
    await cleanCompactionAnnouncementsV1(storage);
    expect((await readVisibleIndexV1(storage)).announcementEntityIds).toContain(
      "ann:compaction-3",
    );
  });
});
