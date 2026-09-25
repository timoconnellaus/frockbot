// Disposable cleanup for the compaction lines the conversation used to
// publish. The wire no longer has a `conversation/compacted` announcement, so
// a stored row or replayed update carrying one fails a current client's
// schema and breaks its state channel.
//
// The replay log cannot lose an entry in the middle without a gap, so it is
// trimmed through the newest compaction update instead: a client behind that
// point gets the ordinary gap reset and reads the cleaned snapshot.

import {
  CONVERSATION_VISIBLE_INDEX_KEY,
  PUBLICATION_HEAD_KEY,
  PUBLICATION_PENDING_PREFIX,
  conversationRowKeyV1,
  conversationUpdateKeyV1,
  readPublicationHeadV1,
  readVisibleIndexV1,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:compaction-announcements:2026-09-25";
const COMPACTION_ENTITY_PREFIX = "ann:compaction-";

interface CleanupStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number | void>;
  list<T = unknown>(options: { prefix?: string }): Promise<Map<string, T>>;
}

function isCompactionEntity(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityId" in value &&
    typeof value.entityId === "string" &&
    value.entityId.startsWith(COMPACTION_ENTITY_PREFIX)
  );
}

export async function cleanCompactionAnnouncementsV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let removed = 0;

  const index = await readVisibleIndexV1(storage);
  const compactions = index.announcementEntityIds.filter((id) =>
    id.startsWith(COMPACTION_ENTITY_PREFIX),
  );
  if (compactions.length > 0) {
    await storage.put(CONVERSATION_VISIBLE_INDEX_KEY, {
      ...index,
      announcementEntityIds: index.announcementEntityIds.filter(
        (id) => !id.startsWith(COMPACTION_ENTITY_PREFIX),
      ),
    });
    await storage.delete(compactions.map(conversationRowKeyV1));
    removed += compactions.length;
  }

  const head = await readPublicationHeadV1(storage);
  let through = 0;
  for (
    let cursor = head.firstRetainedCursor;
    cursor <= head.lastCursor;
    cursor += 1
  ) {
    const update = await storage.get(conversationUpdateKeyV1(cursor));
    if (isCompactionEntity(update)) through = cursor;
  }
  if (through > 0) {
    const expired: string[] = [];
    for (let cursor = head.firstRetainedCursor; cursor <= through; cursor++) {
      expired.push(conversationUpdateKeyV1(cursor));
    }
    await storage.delete(expired);
    // An undrained broadcast at or before the trim point is either a
    // compaction nobody should see or an update the snapshot now carries.
    const pending = await storage.list({ prefix: PUBLICATION_PENDING_PREFIX });
    const stale = [...pending].filter(
      ([, value]) =>
        typeof value === "object" &&
        value !== null &&
        "cursor" in value &&
        typeof value.cursor === "number" &&
        value.cursor <= through,
    );
    if (stale.length > 0) await storage.delete(stale.map(([key]) => key));
    await storage.put(PUBLICATION_HEAD_KEY, {
      ...head,
      firstRetainedCursor: through + 1,
      broadcastThrough: Math.max(head.broadcastThrough, through),
    });
    removed += expired.length;
  }

  await storage.put(RECEIPT, { schemaVersion: 1, removed });
}
