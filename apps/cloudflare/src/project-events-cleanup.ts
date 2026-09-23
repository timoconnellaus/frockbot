// Disposable cleanup for the Session events Projects left behind.
//
// Group Chats replaced Projects. A Memory event's `project` scope reads as
// `group` now, and its `projectId` as `groupId`: Memory already kept a
// Project's facts in its shared `groupChat` scope under that id, so the
// record stays true. The two Project membership events become the Memory
// Package's call and result they were, so no event is dropped and no
// sequence number moves. Each Session is rewritten in its own transaction;
// the walk is once per Bot.

import {
  LATEST_EVENTS_KEY,
  SESSION_EVENT_LOG_INDEX_PREFIX,
  SessionEventLog,
  type SessionEventLogStorage,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:project-events:2026-09-23";
const PAGE = 50;

interface CleanupStorage extends SessionEventLogStorage {
  transaction<T>(body: (tx: SessionEventLogStorage) => Promise<T>): Promise<T>;
}

type Stored = Record<string, unknown>;

function scoped(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }
  const { projectId, ...rest } = entry as Stored;
  const scope = rest.scope === "project" ? "group" : rest.scope;
  return projectId === undefined
    ? { ...rest, scope }
    : { ...rest, scope, groupId: projectId };
}

function each(value: unknown): unknown {
  return Array.isArray(value) ? value.map(scoped) : value;
}

/** The replacement for one stored event, or `undefined` to keep it. */
export function withoutProjectShapesV1(event: Stored): Stored | undefined {
  const replaced = replacement(event);
  // An event already in today's shape is left alone, so a second walk after
  // an interrupted one writes nothing it already wrote.
  return replaced && JSON.stringify(replaced) !== JSON.stringify(event)
    ? replaced
    : undefined;
}

function replacement(event: Stored): Stored | undefined {
  const common = { seq: event.seq, timestamp: event.timestamp };
  switch (event.type) {
    case "memory/injected":
      return {
        ...event,
        sources: each(event.sources),
        facts: each(event.facts),
        omissions: each(event.omissions),
        ...(Object.hasOwn(event, "faded") ? { faded: each(event.faded) } : {}),
      };
    case "memory/write-intent":
    case "memory/written":
      return scoped(event) as Stored;
    case "memory/project-intent":
      return {
        type: "package/tool-call",
        ...common,
        turn: event.turn,
        step: event.step,
        effectId: event.effectId,
        packageId: "memory",
        callId: event.effectId,
        name: `project_${String(event.action)}`,
        input: { project: event.projectId },
      };
    case "memory/project-changed": {
      const projects = Array.isArray(event.projects) ? event.projects : [];
      return {
        type: "package/tool-result",
        ...common,
        turn: event.turn,
        step: event.step,
        effectId: event.effectId,
        packageId: "memory",
        callId: event.effectId,
        name: `project_${String(event.action)}`,
        content: `Projects: ${projects.join(", ") || "none"}`,
        isError: false,
      };
    }
    default:
      return undefined;
  }
}

export async function cleanProjectEventsV1(
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
        new SessionEventLog(tx).repairStoredEvents(
          sessionId,
          withoutProjectShapesV1,
        ),
      );
    } catch {
      // A throw here would reset the object on every wake. A log this cannot
      // read was unreadable before it ran, and is left as it was.
      unreadable.push(sessionId);
    }
  }
  // The pre-paging log, if a Bot still has one, is read the same way.
  const legacy = await storage.get<unknown[]>(LATEST_EVENTS_KEY);
  if (Array.isArray(legacy)) {
    let changed = false;
    const repaired = legacy.map((event) => {
      if (!event || typeof event !== "object") return event;
      const replacement = withoutProjectShapesV1(event as Stored);
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
