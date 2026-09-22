// Projects the working context for Sessions whose event log predates it.
//
// The working-context head arrived after these logs were written, and an
// append to a log with events but no head is refused as a gap, so every Turn
// on such a Session failed before its first event. Rebuilding is an archive
// read, which ordinary startup never does; the receipt makes it once per
// object. A log this process cannot read gets an empty context that starts
// after it, so the Bot answers without that history rather than not at all.

import {
  emptyConversationHeadV1,
  type SessionEvent,
} from "@frockbot/core/contracts";
import {
  SESSION_EVENT_LOG_INDEX_PREFIX,
  SessionEventLog,
  requireConversationHeadV1,
  workingContextHeadKeyV1,
  type WorkingContextStorageV1,
} from "@frockbot/core/durable";
import { replaceWorkingContextV1 } from "@frockbot/app/shell/working-context-store";

const RECEIPT = "maintenance:working-context-head:2026-09-23";
const PAGE = 50;

interface CleanupStorage extends WorkingContextStorageV1 {
  transaction<T>(body: (tx: WorkingContextStorageV1) => Promise<T>): Promise<T>;
}

export async function projectUnprojectedSessionsV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  const sessions: { sessionId: string; eventCount: number }[] = [];
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list<{ eventCount?: number }>({
      prefix: SESSION_EVENT_LOG_INDEX_PREFIX,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    for (const [key, index] of listed) {
      const eventCount = index?.eventCount;
      if (!Number.isSafeInteger(eventCount) || eventCount! <= 0) continue;
      sessions.push({
        sessionId: decodeURIComponent(
          key.slice(SESSION_EVENT_LOG_INDEX_PREFIX.length),
        ),
        eventCount: eventCount!,
      });
    }
    if (listed.size < PAGE) break;
    start = `${[...listed.keys()].at(-1)}\0`;
  }
  const rebuilt: { sessionId: string; events: number; from: string }[] = [];
  for (const { sessionId, eventCount } of sessions) {
    if (await storage.get(workingContextHeadKeyV1(sessionId))) continue;
    let events: SessionEvent[] | undefined;
    try {
      events = await new SessionEventLog(storage).read(sessionId);
    } catch {
      events = undefined;
    }
    await storage.transaction(async (tx) => {
      const existing = requireConversationHeadV1(
        await tx.get(workingContextHeadKeyV1(sessionId)),
        sessionId,
      );
      if (existing) return;
      if (events) {
        await replaceWorkingContextV1(tx, sessionId, events);
        return;
      }
      // Every Turn writes at least one event, so no earlier Turn number
      // reaches past the event count.
      await tx.put(workingContextHeadKeyV1(sessionId), {
        ...emptyConversationHeadV1(sessionId),
        nextSeq: eventCount,
        projectedThroughSeq: eventCount,
        nextTurn: eventCount + 1,
      });
    });
    rebuilt.push({
      sessionId,
      events: eventCount,
      from: events ? "log" : "empty",
    });
  }
  await storage.put(RECEIPT, { schemaVersion: 1, rebuilt });
  if (rebuilt.length) {
    console.info({ event: "working-context-cleanup", rebuilt });
  }
}
