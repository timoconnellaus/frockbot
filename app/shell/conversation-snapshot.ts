/**
 * Newest conversation page for a snapshot+stream handshake. Read together
 * with the publication head so the cursor names this exact projection.
 */
import {
  BOT_ANNOUNCEMENT_PREFIX,
  BOT_ANNOUNCEMENT_RETENTION,
} from "./reads.js";
import {
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  readVisibleIndexV1,
  readConversationRowV1,
} from "@frockbot/core/durable";
import { decodeSessionEvent } from "@frockbot/core/contracts";
import { requireStoredRunV1 } from "./backend-contracts.js";
import {
  CLIENT_RUN_PAGE_LIMIT,
  isVisibleRunV1,
  projectClientAnnouncementsV1,
  projectClientRunV1,
  type ClientRunListV1,
  type ClientRunV1,
} from "./run-protocol.js";

export interface ConversationSnapshotStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: {
    prefix: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>>;
}

function runFromRow(payload: unknown): ClientRunV1 | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const run = (payload as { run?: unknown }).run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return undefined;
  return run as ClientRunV1;
}

async function snapshotFromIndex(
  storage: ConversationSnapshotStorageV1,
): Promise<ClientRunListV1 | undefined> {
  const index = await readVisibleIndexV1(storage);
  if (
    index.runEntityIds.length === 0 &&
    index.announcementEntityIds.length === 0
  ) {
    return undefined;
  }
  const runs: ClientRunV1[] = [];
  for (const entityId of index.runEntityIds) {
    const row = await readConversationRowV1(storage, entityId);
    const run = row ? runFromRow(row.payload) : undefined;
    if (run) runs.push(run);
  }
  const announcements: ClientRunListV1["announcements"] = [];
  for (const entityId of index.announcementEntityIds) {
    const row = await readConversationRowV1(storage, entityId);
    const announcement =
      row &&
      typeof row.payload === "object" &&
      row.payload !== null &&
      "announcement" in row.payload
        ? (
            row.payload as {
              announcement: NonNullable<
                ClientRunListV1["announcements"]
              >[number];
            }
          ).announcement
        : undefined;
    if (announcement) announcements.push(announcement);
  }
  const listed = await storage.list<string>({
    prefix: RUN_INDEX_PREFIX,
    reverse: true,
    limit: CLIENT_RUN_PAGE_LIMIT + 1,
  });
  const entries = [...listed.keys()];
  const truncated = entries.length > CLIENT_RUN_PAGE_LIMIT;
  return {
    schemaVersion: 1,
    runs,
    page: {
      truncated,
      ...(truncated && entries[CLIENT_RUN_PAGE_LIMIT - 1]
        ? { nextCursor: entries[CLIENT_RUN_PAGE_LIMIT - 1] }
        : {}),
    },
    ...(announcements.length > 0 ? { announcements } : {}),
  };
}

async function snapshotFromArchive(
  storage: ConversationSnapshotStorageV1,
): Promise<ClientRunListV1> {
  const index = await storage.list<string>({
    prefix: RUN_INDEX_PREFIX,
    reverse: true,
    limit: CLIENT_RUN_PAGE_LIMIT + 1,
  });
  const entries = [...index.entries()];
  const truncated = entries.length > CLIENT_RUN_PAGE_LIMIT;
  const kept = truncated ? entries.slice(0, CLIENT_RUN_PAGE_LIMIT) : entries;
  const runs: ClientRunV1[] = [];
  let nextCursor: string | undefined;
  for (const [cursor, runId] of kept) {
    nextCursor = cursor;
    const stored = await storage.get<unknown>(`${RUN_PREFIX}${runId}`);
    if (stored === undefined) continue;
    try {
      const run = requireStoredRunV1(stored);
      if (!isVisibleRunV1(run)) continue;
      runs.push(projectClientRunV1(run));
    } catch {
      continue;
    }
  }
  runs.reverse();
  const storedAnnouncements = await storage.list<unknown>({
    prefix: BOT_ANNOUNCEMENT_PREFIX,
  });
  const events = [...storedAnnouncements.values()]
    .map((value) => {
      try {
        return decodeSessionEvent(value);
      } catch {
        return undefined;
      }
    })
    .filter((event): event is NonNullable<typeof event> => event !== undefined)
    .sort((left, right) => left.seq - right.seq)
    .slice(-BOT_ANNOUNCEMENT_RETENTION);
  const announcements = projectClientAnnouncementsV1(events);
  return {
    schemaVersion: 1,
    runs,
    page: {
      truncated,
      ...(truncated && nextCursor ? { nextCursor } : {}),
    },
    ...(announcements.length > 0 ? { announcements } : {}),
  };
}

export async function readConversationSnapshotV1(
  storage: ConversationSnapshotStorageV1,
): Promise<ClientRunListV1> {
  return (await snapshotFromIndex(storage)) ?? snapshotFromArchive(storage);
}
