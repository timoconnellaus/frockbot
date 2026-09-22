// Cursor half of the working-context projection.
//
// The event log remains authoritative. This module advances the absolute
// cursor in the same transaction as an append, and refuses a gap, a partial
// overlap, or an epoch that is not the head's. Turn pages and history policy
// are applied by the registered projector; without one, the head records a
// cursor only and a model request must not be assembled from it.
import {
  emptyConversationHeadV1,
  WORKING_CONTEXT_SCHEMA_VERSION_V1,
  type ConversationHeadV1,
  type SessionCursorV1,
  type SessionEvent,
} from "@frockbot/core/contracts";
import {
  SESSION_EVENT_LOG_INDEX_PREFIX,
  workingContextHeadKeyV1,
} from "./storage-keys.js";

function sessionEventIndexKey(sessionId: string): string {
  return `${SESSION_EVENT_LOG_INDEX_PREFIX}${encodeURIComponent(sessionId)}`;
}

/** The slice of durable storage the projection shares with the event log. */
export interface WorkingContextStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: {
    prefix: string;
    start?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>>;
}

export interface WorkingContextAppendMetaV1 {
  runId?: string;
  /** Reject the append when the head's epoch is not this one. */
  expectedEpoch?: number;
}

export interface WorkingContextProjectorV1 {
  append(
    storage: WorkingContextStorageV1,
    sessionId: string,
    events: readonly SessionEvent[],
    meta?: WorkingContextAppendMetaV1,
  ): Promise<void>;
  replace(
    storage: WorkingContextStorageV1,
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void>;
  truncate(
    storage: WorkingContextStorageV1,
    sessionId: string,
    startSeq: number,
  ): Promise<void>;
}

let projector: WorkingContextProjectorV1 | undefined;

/** The Shell registers the page projector. Core tests leave this unset. */
export function registerWorkingContextProjectorV1(
  next: WorkingContextProjectorV1,
): void {
  projector = next;
}

export function workingContextProjectorV1():
  WorkingContextProjectorV1 | undefined {
  return projector;
}

export type CursorAdvanceV1 =
  { kind: "replay" } | { kind: "reject"; reason: string } | { kind: "apply" };

export function requireConversationHeadV1(
  value: unknown,
  sessionId: string,
): ConversationHeadV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error(`working context head for "${sessionId}" is corrupt`);
  }
  const head = value as ConversationHeadV1;
  if (
    head.schemaVersion !== WORKING_CONTEXT_SCHEMA_VERSION_V1 ||
    head.sessionId !== sessionId ||
    !Number.isSafeInteger(head.epoch) ||
    head.epoch < 1 ||
    !Number.isSafeInteger(head.nextSeq) ||
    head.nextSeq < 0 ||
    !Number.isSafeInteger(head.nextTurn) ||
    head.nextTurn < 1 ||
    !Number.isSafeInteger(head.projectedThroughSeq) ||
    head.projectedThroughSeq < 0 ||
    (head.status !== "ready" &&
      head.status !== "cursor" &&
      head.status !== "unavailable")
  ) {
    throw new Error(`working context head for "${sessionId}" is corrupt`);
  }
  return head;
}

/**
 * Whether `events` continue the projection, repeat a range already projected,
 * or must be refused.
 */
export function planCursorAdvanceV1(
  head: ConversationHeadV1 | undefined,
  sessionId: string,
  events: readonly SessionEvent[],
  expectedEpoch?: number,
): CursorAdvanceV1 {
  if (events.length === 0) return { kind: "replay" };
  const start = events[0]!.seq;
  for (const [offset, event] of events.entries()) {
    if (event.seq !== start + offset) {
      return { kind: "reject", reason: "projection batch is not contiguous" };
    }
  }
  const end = events[events.length - 1]!.seq + 1;
  if (!head) {
    if (start !== 0) {
      return {
        kind: "reject",
        reason: "projection is missing the events before this batch",
      };
    }
    return { kind: "apply" };
  }
  if (expectedEpoch !== undefined && expectedEpoch !== head.epoch) {
    return { kind: "reject", reason: "projection epoch does not match" };
  }
  if (head.status === "unavailable") {
    return {
      kind: "reject",
      reason: head.unavailableReason ?? "working context is unavailable",
    };
  }
  if (end <= head.projectedThroughSeq) return { kind: "replay" };
  if (start !== head.projectedThroughSeq) {
    return { kind: "reject", reason: "projection gap or overlap" };
  }
  return { kind: "apply" };
}

export function advanceConversationHeadV1(
  head: ConversationHeadV1,
  events: readonly SessionEvent[],
): ConversationHeadV1 {
  let next: ConversationHeadV1 = {
    ...head,
    projectedThroughSeq: events[events.length - 1]!.seq + 1,
    nextSeq: events[events.length - 1]!.seq + 1,
    revision: head.revision + 1,
  };
  for (const event of events) {
    if (event.type === "turn/start") {
      next = {
        ...next,
        nextTurn: Math.max(next.nextTurn, event.turn + 1),
        openTurn: event.turn,
      };
    } else if (event.type === "turn/end" && next.openTurn === event.turn) {
      const { openTurn: _open, ...rest } = next;
      next = rest;
    }
  }
  return next;
}

interface EventIndexCountV1 {
  eventCount?: number;
}

export async function readSessionCursorV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
): Promise<
  | {
      availability: "ready" | "empty";
      cursor: SessionCursorV1;
      head?: ConversationHeadV1;
    }
  | { availability: "unavailable"; cursor: SessionCursorV1; reason: string }
> {
  let head: ConversationHeadV1 | undefined;
  try {
    head = requireConversationHeadV1(
      await storage.get(workingContextHeadKeyV1(sessionId)),
      sessionId,
    );
  } catch (error) {
    const index = await storage.get<EventIndexCountV1>(
      sessionEventIndexKey(sessionId),
    );
    const nextSeq =
      index && Number.isSafeInteger(index.eventCount) ? index.eventCount! : 0;
    return {
      availability: "unavailable",
      reason:
        error instanceof Error ? error.message : "working context is corrupt",
      cursor: { sessionId, epoch: 1, nextSeq, nextTurn: 1 },
    };
  }
  if (head?.status === "unavailable") {
    return {
      availability: "unavailable",
      reason: head.unavailableReason ?? "working context is unavailable",
      cursor: cursorFromHead(head),
    };
  }
  if (head?.status === "ready" || head?.status === "cursor") {
    // A cursor-only head can allocate sequence numbers. It cannot assemble a
    // request; callers that need messages treat `cursor` as unavailable.
    if (head.status === "cursor") {
      return {
        availability: "unavailable",
        reason: "working context pages have not been projected",
        cursor: cursorFromHead(head),
      };
    }
    return { availability: "ready", cursor: cursorFromHead(head), head };
  }
  const index = await storage.get<EventIndexCountV1>(
    sessionEventIndexKey(sessionId),
  );
  const eventCount =
    index && Number.isSafeInteger(index.eventCount) ? index.eventCount! : 0;
  if (eventCount > 0) {
    return {
      availability: "unavailable",
      reason: "working context projection is missing",
      cursor: { sessionId, epoch: 1, nextSeq: eventCount, nextTurn: 1 },
    };
  }
  const created = emptyConversationHeadV1(sessionId);
  return { availability: "empty", cursor: cursorFromHead(created) };
}

function cursorFromHead(head: ConversationHeadV1): SessionCursorV1 {
  return {
    sessionId: head.sessionId,
    epoch: head.epoch,
    nextSeq: head.nextSeq,
    nextTurn: head.nextTurn,
  };
}

/**
 * Advances the cursor when no page projector is registered.
 *
 * Replayed ranges write nothing. A gap, an overlap, or a corrupt head fails
 * the transaction that appended the events.
 */
export async function projectSessionAppendV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  events: readonly SessionEvent[],
  meta?: WorkingContextAppendMetaV1,
): Promise<void> {
  const registered = projector;
  if (registered) {
    await registered.append(storage, sessionId, events, meta);
    return;
  }
  await writeCursorOnlyV1(storage, sessionId, events, meta?.expectedEpoch);
}

export async function projectSessionReplaceV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  events: readonly SessionEvent[],
): Promise<void> {
  if (projector) {
    await projector.replace(storage, sessionId, events);
    return;
  }
  const head = emptyConversationHeadV1(sessionId);
  head.status = "cursor";
  head.epoch = 2;
  if (events.length === 0) {
    await storage.put(workingContextHeadKeyV1(sessionId), head);
    return;
  }
  await storage.put(
    workingContextHeadKeyV1(sessionId),
    advanceConversationHeadV1(head, events),
  );
}

export async function projectSessionTruncateV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  startSeq: number,
): Promise<void> {
  if (projector) {
    await projector.truncate(storage, sessionId, startSeq);
    return;
  }
  const head = requireConversationHeadV1(
    await storage.get(workingContextHeadKeyV1(sessionId)),
    sessionId,
  );
  if (!head || startSeq >= head.projectedThroughSeq) return;
  await storage.put(workingContextHeadKeyV1(sessionId), {
    ...head,
    projectedThroughSeq: startSeq,
    nextSeq: startSeq,
    revision: head.revision + 1,
    epoch: head.epoch + 1,
    status: "cursor",
  });
}

async function writeCursorOnlyV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  events: readonly SessionEvent[],
  expectedEpoch?: number,
): Promise<void> {
  const existing = requireConversationHeadV1(
    await storage.get(workingContextHeadKeyV1(sessionId)),
    sessionId,
  );
  const plan = planCursorAdvanceV1(existing, sessionId, events, expectedEpoch);
  if (plan.kind === "replay") return;
  if (plan.kind === "reject") throw new Error(plan.reason);
  const base = existing ?? {
    ...emptyConversationHeadV1(sessionId),
    status: "cursor" as const,
  };
  const next = advanceConversationHeadV1(
    base.status === "ready" ? { ...base, status: "cursor" } : base,
    events,
  );
  next.status = "cursor";
  await storage.put(workingContextHeadKeyV1(sessionId), next);
}
