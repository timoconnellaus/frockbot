// Disposable cleanup for `supervision/call` events stored before a verdict
// named the call it was given for.
//
// Each event now carries `callDigest`, and a verdict is reused only for a call
// with that digest. An older event records no call, so it is given a digest
// no call has: its verdict is never reused, and a resumed Turn reviews that
// call afresh. Each Session is rewritten in its own transaction, keeping every
// sequence number; the walk is once per Bot.

import {
  LATEST_EVENTS_KEY,
  SESSION_EVENT_LOG_INDEX_PREFIX,
  SessionEventLog,
  type SessionEventLogStorage,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:supervision-call-digest:2026-09-28";
const PAGE = 50;

/** Matches no digest: `callDigest` is hex. */
export const UNRECORDED_CALL_DIGEST_V1 = "unrecorded";

interface CleanupStorage extends SessionEventLogStorage {
  transaction<T>(body: (tx: SessionEventLogStorage) => Promise<T>): Promise<T>;
}

type Stored = Record<string, unknown>;

/** The replacement for one stored event, or `undefined` to keep it. */
export function withCallDigestV1(event: Stored): Stored | undefined {
  if (event.type !== "supervision/call" || Object.hasOwn(event, "callDigest")) {
    return undefined;
  }
  return { ...event, callDigest: UNRECORDED_CALL_DIGEST_V1 };
}

export async function cleanSupervisionCallDigestsV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  const sessions: string[] = [];
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix: SESSION_EVENT_LOG_INDEX_PREFIX,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    for (const key of listed.keys()) {
      sessions.push(
        decodeURIComponent(key.slice(SESSION_EVENT_LOG_INDEX_PREFIX.length)),
      );
    }
    if (listed.size < PAGE) break;
    start = `${[...listed.keys()].at(-1)}\0`;
  }
  let events = 0;
  const unreadable: string[] = [];
  for (const sessionId of sessions) {
    try {
      events += await storage.transaction((tx) =>
        new SessionEventLog(tx).repairStoredEvents(sessionId, withCallDigestV1),
      );
    } catch {
      // A throw here would reset the object on every wake. A log this cannot
      // read was unreadable before it ran, and is left as it was.
      unreadable.push(sessionId);
    }
  }
  const legacy = await storage.get<unknown[]>(LATEST_EVENTS_KEY);
  if (Array.isArray(legacy)) {
    let changed = false;
    const repaired = legacy.map((event) => {
      if (!event || typeof event !== "object") return event;
      const replacement = withCallDigestV1(event as Stored);
      if (replacement) changed = true;
      return replacement ?? event;
    });
    if (changed) await storage.put(LATEST_EVENTS_KEY, repaired);
  }
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    sessions: sessions.length,
    events,
    unreadable,
  });
}
