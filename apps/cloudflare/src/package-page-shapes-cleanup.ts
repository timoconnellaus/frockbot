// Disposable pre-user cleanup for the turn-log shapes the Package page
// pipeline left behind.
//
// The Applet canvas admitted a Package page's tool call as a `directTool`
// run, and an Applet publish reconciled the Computer with a `publish` sync.
// Both producers are gone and neither decoder accepts the value, so this
// rewrites them before anything decodes a run or a Session event.
//
// A finished run keeps its transcript and loses the field: it reads as the
// ordinary Turn it was drawn as. An unfinished one could only resume as a chat
// Turn replaying its label, so it is removed with the pointers that named it,
// as the prepared-input cleanup does. A `publish` sync becomes `signal`, the
// other mid-Turn reason: the event is diagnostic, its counts stay true, and no
// sequence number moves. The walk is once per Bot; it pages rather than
// loading the archive into one value.

import {
  ACTIVE_RUN_KEY,
  LATEST_EVENTS_KEY,
  PENDING_AGENT_RUN_PREFIX,
  PENDING_USER_RUN_PREFIX,
  REPAIR_DUE_PREFIX,
  REPAIR_RUN_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  SESSION_EVENT_LOG_INDEX_PREFIX,
  SessionEventLog,
  type SessionEventLogStorage,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:package-page-shapes:2026-09-24";
const PAGE = 50;

interface CleanupStorage extends SessionEventLogStorage {
  delete(key: string): Promise<boolean>;
  transaction<T>(body: (tx: SessionEventLogStorage) => Promise<T>): Promise<T>;
}

type Stored = Record<string, unknown>;

function record(value: unknown): Stored | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Stored;
}

/** The event without a `publish` sync, or `undefined` to keep it. */
export function withoutPublishSyncV1(event: Stored): Stored | undefined {
  return event.type === "computer/sync" && event.reason === "publish"
    ? { ...event, reason: "signal" }
    : undefined;
}

/** The run without Package page shapes, or `undefined` to keep it. */
function withoutPackagePageShapes(run: Stored): Stored | undefined {
  let changed = false;
  const cleaned = { ...run };
  if (Object.hasOwn(cleaned, "directTool")) {
    delete cleaned.directTool;
    changed = true;
  }
  if (Array.isArray(cleaned.events)) {
    cleaned.events = cleaned.events.map((event) => {
      const stored = record(event);
      const replaced = stored && withoutPublishSyncV1(stored);
      if (!replaced) return event;
      changed = true;
      return replaced;
    });
  }
  return changed ? cleaned : undefined;
}

function isTerminal(run: Stored): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

async function page(
  storage: CleanupStorage,
  prefix: string,
  visit: (key: string, value: unknown) => Promise<void>,
): Promise<void> {
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    if (listed.size === 0) return;
    let last = "";
    for (const [key, value] of listed) {
      last = key;
      if (start !== undefined && key === start) continue;
      await visit(key, value);
    }
    if (listed.size < PAGE) return;
    start = `${last}\0`;
  }
}

export async function cleanPackagePageShapesV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let rewrittenRuns = 0;
  const removed = new Set<string>();
  await page(storage, RUN_PREFIX, async (key, value) => {
    const run = record(value);
    if (!run) return;
    if (Object.hasOwn(run, "directTool") && !isTerminal(run)) {
      if (typeof run.runId === "string") removed.add(run.runId);
      await storage.delete(key);
      return;
    }
    const cleaned = withoutPackagePageShapes(run);
    if (!cleaned) return;
    rewrittenRuns += 1;
    await storage.put(key, cleaned);
  });
  if (removed.size > 0) {
    const active = await storage.get(ACTIVE_RUN_KEY);
    if (typeof active === "string" && removed.has(active)) {
      await storage.delete(ACTIVE_RUN_KEY);
    }
    for (const prefix of [
      PENDING_USER_RUN_PREFIX,
      PENDING_AGENT_RUN_PREFIX,
      RUN_INDEX_PREFIX,
      REPAIR_DUE_PREFIX,
    ]) {
      await page(storage, prefix, async (key, value) => {
        if (typeof value === "string" && removed.has(value)) {
          await storage.delete(key);
        }
      });
    }
    for (const runId of removed) {
      await storage.delete(`${REPAIR_RUN_PREFIX}${runId}`);
    }
  }

  const sessions: string[] = [];
  await page(storage, SESSION_EVENT_LOG_INDEX_PREFIX, async (key) => {
    sessions.push(
      decodeURIComponent(key.slice(SESSION_EVENT_LOG_INDEX_PREFIX.length)),
    );
  });
  let events = 0;
  const unreadable: string[] = [];
  for (const sessionId of sessions) {
    try {
      events += await storage.transaction((tx) =>
        new SessionEventLog(tx).repairStoredEvents(
          sessionId,
          withoutPublishSyncV1,
        ),
      );
    } catch {
      // A throw here would reset the object on every wake. A log this cannot
      // read was unreadable before it ran, and is left as it was.
      unreadable.push(sessionId);
    }
  }
  // The pre-paging log, if a Bot still has one, is read the same way.
  const legacy = await storage.get(LATEST_EVENTS_KEY);
  if (Array.isArray(legacy)) {
    let changed = false;
    const repaired = legacy.map((event) => {
      const stored = record(event);
      const replaced = stored && withoutPublishSyncV1(stored);
      if (!replaced) return event;
      changed = true;
      events += 1;
      return replaced;
    });
    if (changed) await storage.put(LATEST_EVENTS_KEY, repaired);
  }
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    rewrittenRuns,
    removedRuns: removed.size,
    events,
    unreadable,
  });
}
