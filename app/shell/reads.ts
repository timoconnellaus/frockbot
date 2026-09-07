// The Bot's read-only client projections: the transcript page, the
// conversation list, one run's lookup, the unprojected event page, and the
// announcement log the transcript is assembled with.

import {
  decodeSessionEvent,
  type SessionEvent,
} from "@frockbot/core/contracts";
import {
  CONVERSATION_BUSY_MESSAGE_V1,
  isConversationBusyV1,
  type BotIdentity,
} from "@frockbot/core/durable";
import type { StoredRunStatus } from "./backend-contracts.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  CLIENT_RUN_SCAN_LIMIT,
  clientRunListWireBytes,
  createClientRunListV1,
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  isVisibleRunV1,
  projectClientAnnouncementsV1,
  projectClientRunLookupV1,
  projectClientRunOrDegradedV1,
  type ClientConversationListV1,
  type ClientConversationOutcomeV1,
  type ClientRunListV1,
  type ClientRunLookupV1,
  type ClientRunV1,
} from "./run-protocol.js";

/**
 * The Bot's durable announcement log: Session events that happen outside any
 * Turn, such as a rename.
 */
export const BOT_ANNOUNCEMENT_PREFIX = "bot-announcement:";
export const BOT_ANNOUNCEMENT_SEQUENCE_KEY = "bot-announcement-sequence";
/** How many announcements the Session keeps. */
export const BOT_ANNOUNCEMENT_RETENTION = 32;

export function botAnnouncementKey(seq: number): string {
  return `${BOT_ANNOUNCEMENT_PREFIX}${String(seq).padStart(12, "0")}`;
}

/** The narrow storage seam the Bot's announcement log is written through. */
export interface BotAnnouncementTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
}

/**
 * Appends one durable Session event that belongs to no Turn.
 *
 * A rename is one; so is a task settling, because a background subagent
 * settles after the Turn that dispatched it is over and there is no live
 * Session left to append to. The log is append-only and bounded — an
 * announcement is conversational history, not authority.
 */
export async function appendAnnouncement(
  transaction: BotAnnouncementTransaction,
  build: (seq: number) => SessionEvent,
): Promise<void> {
  const seq =
    ((await transaction.get<number>(BOT_ANNOUNCEMENT_SEQUENCE_KEY)) ?? -1) + 1;
  const event = build(seq);
  await transaction.put({
    [botAnnouncementKey(seq)]: event,
    [BOT_ANNOUNCEMENT_SEQUENCE_KEY]: seq,
  });
  const stored = await transaction.list<unknown>({
    prefix: BOT_ANNOUNCEMENT_PREFIX,
  });
  const expired = [...stored.keys()]
    .sort()
    .slice(0, Math.max(0, stored.size - BOT_ANNOUNCEMENT_RETENTION));
  if (expired.length > 0) await transaction.delete(expired);
}

/**
 * Whether the Bot's newest admitted run is still going.
 *
 * The sidebar draws this as an activity ring, so somebody in another
 * conversation can see a Bot working rather than reading a quiet row as a
 * stalled one. It is the newest run only: a Bot admits one Turn at a time,
 * so an older run that is somehow still marked running is a reconciliation
 * problem and not something a ring should report. A read that fails is no
 * ring — liveness is never worth failing a sidebar poll for.
 *
 * The record's `status` is not the test and never was. `resolveRunWorking`
 * holds the rule — running, inside the Turn deadline, and a Turn the log has
 * not already closed — and settles the record when it finds one that only
 * claims to be running, which is why this read is also the repair.
 */
export async function runWorkingV1(
  state: ShellBotStateV1,
  runId: string | undefined,
): Promise<boolean> {
  try {
    return await state.authority.resolveRunWorking(runId);
  } catch {
    return false;
  }
}

/**
 * The announcements the Session shows, oldest first.
 *
 * Two sources, and deliberately so. A rename or a settled task has no live
 * Session to be appended to, so it lives in this object's own bounded
 * announcement log. A compaction is already a durable event on the
 * conversation's session log — appending a second copy of it here would be
 * two records of one fact — so it is read back from there instead.
 * The transcript injects that log after reading it once, because marker
 * collection and marker placement consume the same events.
 */
export async function announcementsFromSession(
  state: ShellBotStateV1,
  conversationEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  const stored = await state.ctx.storage.list<unknown>({
    prefix: BOT_ANNOUNCEMENT_PREFIX,
  });
  const announcements = [...stored.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => decodeSessionEvent(value));
  for (const event of conversationEvents) {
    if (event.type === "conversation/compacted") announcements.push(event);
  }
  return announcements
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-BOT_ANNOUNCEMENT_RETENTION);
}

/**
 * The announcements as the transcript reads them, each already carrying the
 * timestamp of the place it belongs rather than the moment it was written.
 */
export async function projectAnnouncementPage(state: ShellBotStateV1) {
  const sessionId = await state.authority.readConversationSessionId();
  const session = sessionId
    ? await state.authority.readSessionEvents(sessionId)
    : [];
  return projectClientAnnouncementsV1(
    await announcementsFromSession(state, session),
    session,
  );
}

export async function listRuns(
  state: ShellBotStateV1,
  input: unknown = { schemaVersion: 1 },
): Promise<ClientRunListV1> {
  const query = decodeClientRunListQueryV1(input);
  await state.authority.recoverActiveRun();
  // The transcript is one conversation, not every Turn the Bot has ever
  // run. Absent means the conversation the Bot is on; naming an earlier one
  // reads it exactly as it was left. A Bot whose object has not learned its
  // identity yet has no conversation to filter by and shows what it has.
  const conversationId =
    query.conversationId ?? (await state.authority.readConversationSessionId());
  // A record nobody can decode has no trustworthy session id, and a
  // transcript that hid it would be back to silently losing the Turn. An
  // unknown session belongs to the conversation being read.
  const inConversation = (run: { sessionId?: string }) =>
    conversationId === undefined ||
    run.sessionId === undefined ||
    run.sessionId === conversationId;
  const activeRunId = query.before
    ? undefined
    : await state.authority.readActiveRunId();
  const candidates = await state.authority.listRunIndex({
    limit: CLIENT_RUN_PAGE_LIMIT + 1,
    ...(query.before ? { before: query.before } : {}),
  });
  // The open chat draws its own activity ring from whichever run this page
  // projects as `running`, so it owes the same liveness rule the sidebar row
  // does — and from the same helper, or the two surfaces disagree about the
  // same Bot. Only the newest run and the active marker are asked: a Turn
  // further back cannot be the one anybody is waiting on, and a transcript
  // read is not the place to walk a Bot's whole history looking for
  // leftovers.
  if (!query.before) {
    await runWorkingV1(state, activeRunId ?? candidates[0]?.runId);
  }

  const selected = new Map<string, { cursor?: string; run: ClientRunV1 }>();
  if (activeRunId) {
    const active =
      await state.authority.readStoredRunForDisplayOrDegraded(activeRunId);
    // An automation firing occupies the object like any other run, and is
    // still not part of the conversation: the visible transcript never
    // shows one, running or settled.
    if (active && isVisibleRunV1(active.run) && inConversation(active.run))
      selected.set(active.run.runId, {
        run: projectClientRunOrDegradedV1(active.run),
      });
  }
  // The run index is global and the transcript is one conversation, so a
  // page of candidates is not a page of answers: 33 Turns of another
  // conversation, or of automation, used to come back as an empty,
  // *untruncated* page that told the client there was nothing older. The
  // scan cursor now advances over every candidate this call consumed,
  // whether or not it was kept, so a filtered-out page still says where to
  // resume; and the scan keeps reading batches, up to a budget, so the
  // common case answers in one request rather than making the client walk
  // the history a page at a time. Filtering reads run records only —
  // hydrating a Turn's journal is what selection costs, not what the scan
  // costs.
  let stoppedEarly = false;
  let exhausted = false;
  let scanCursor: string | undefined;
  let scanned = 0;
  let batch = candidates;
  for (;;) {
    const available = batch.slice(0, CLIENT_RUN_PAGE_LIMIT);
    const hasMore = batch.length > CLIENT_RUN_PAGE_LIMIT;
    for (const candidate of available) {
      if (selected.has(candidate.runId)) {
        const current = selected.get(candidate.runId)!;
        selected.set(candidate.runId, {
          ...current,
          cursor: candidate.cursor,
        });
        scanCursor = candidate.cursor;
        continue;
      }
      // Display-only reads: strictness here would throw the whole page away
      // over one bad row, which is exactly the transcript that vanished.
      const header = await state.authority.readRunHeaderForDisplay(
        candidate.runId,
      );
      if (
        !header ||
        !isVisibleRunV1(header.run) ||
        !inConversation(header.run)
      ) {
        scanCursor = candidate.cursor;
        continue;
      }
      const stored = await state.authority.hydrateRunForDisplay(header);
      const projected = projectClientRunOrDegradedV1(stored.run);
      const tentative = [
        ...selected.values(),
        { cursor: candidate.cursor, run: projected },
      ];
      const ordered = tentative
        .map((entry) => entry.run)
        .sort(
          (left, right) =>
            left.admittedAt.localeCompare(right.admittedAt) ||
            left.runId.localeCompare(right.runId),
        );
      const tentativePage = createClientRunListV1(ordered, {
        truncated: true,
        nextCursor: candidate.cursor,
      });
      const isNewestTerminal =
        ![...selected.values()].some(
          (entry) =>
            entry.run.status === "completed" || entry.run.status === "failed",
        ) &&
        (projected.status === "completed" || projected.status === "failed");
      if (
        selected.size >= CLIENT_RUN_PAGE_LIMIT ||
        (!isNewestTerminal &&
          clientRunListWireBytes(tentativePage) > CLIENT_RUN_LIST_MAX_BYTES)
      ) {
        stoppedEarly = true;
        break;
      }
      selected.set(stored.run.runId, {
        cursor: candidate.cursor,
        run: projected,
      });
      scanCursor = candidate.cursor;
    }
    scanned += available.length;
    if (stoppedEarly) break;
    if (!hasMore) {
      exhausted = true;
      break;
    }
    if (selected.size >= CLIENT_RUN_PAGE_LIMIT) break;
    if (scanned >= CLIENT_RUN_SCAN_LIMIT || scanCursor === undefined) break;
    batch = await state.authority.listRunIndex({
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
      before: scanCursor,
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
  }
  const orderedEntries = [...selected.values()].sort(
    (left, right) =>
      left.run.admittedAt.localeCompare(right.run.admittedAt) ||
      left.run.runId.localeCompare(right.run.runId),
  );
  const truncated = !exhausted;
  const page = createClientRunListV1(
    orderedEntries.map((entry) => entry.run),
    truncated && scanCursor
      ? { truncated: true, nextCursor: scanCursor }
      : { truncated: false },
    // Announcements belong to the Session, not to a page of Turns, so only
    // the newest page carries them.
    query.before ? [] : await projectAnnouncementPage(state),
  );
  if (clientRunListWireBytes(page) > CLIENT_RUN_LIST_MAX_BYTES) {
    throw new Error("required run projections exceed the wire byte limit");
  }
  return page;
}

/** The conversations this Bot has had, newest first. */
export async function listConversations(
  state: ShellBotStateV1,
): Promise<ClientConversationListV1> {
  return {
    schemaVersion: 1,
    conversations: (await state.authority.listConversations()).map(
      (conversation) => ({
        schemaVersion: 1 as const,
        conversationId: conversation.sessionId,
        ordinal: conversation.ordinal,
        startedAt: conversation.startedAt,
        ...(conversation.endedAt ? { endedAt: conversation.endedAt } : {}),
      }),
    ),
  };
}

/**
 * Puts this conversation down and starts the next one.
 *
 * Memory is untouched: it is not conversation history, and the point of a
 * new conversation is to prove that it is not.
 */
export async function startConversation(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<ClientConversationOutcomeV1> {
  await state.authority.validateIdentity(identity);
  try {
    await state.authority.startConversation(identity);
  } catch (error) {
    // The one refusal this can give travels as data. Everything else is a
    // genuine failure and still throws, so the boundary above answers 500.
    if (isConversationBusyV1(error)) {
      return {
        status: "refused",
        schemaVersion: 1,
        reason:
          error instanceof Error ? error.message : CONVERSATION_BUSY_MESSAGE_V1,
      };
    }
    throw error;
  }
  return { status: "started", ...(await listConversations(state)) };
}

export async function lookupRun(
  state: ShellBotStateV1,
  input: unknown,
): Promise<ClientRunLookupV1> {
  const query = decodeClientRunLookupQueryV1(input);
  return projectClientRunLookupV1(await state.authority.readRun(query.runId));
}

/**
 * One page of settled runs as their durable session events, newest first.
 *
 * The client projection is not enough for every reader: it drops
 * `call.input`, so a projection that has to identify *what* a tool was asked
 * to do — an audit digest, say — cannot be built from it. This is the same
 * runs, unprojected, offered as the narrow shape such a reader needs and
 * nothing wider: the events, the run id, its admission time, its status. No
 * Composition snapshot, no fingerprint, no configuration.
 *
 * Settled runs only. An in-flight run's events can still change, and a
 * projection built from them would not be reproducible.
 */
export async function listRunEventPage(
  state: ShellBotStateV1,
  cursor?: string,
): Promise<{
  schemaVersion: 1;
  runs: Array<{
    runId: string;
    acceptedAt: string;
    status: StoredRunStatus;
    events: SessionEvent[];
  }>;
  nextCursor?: string;
}> {
  const candidates = await state.authority.listRunIndex({
    limit: CLIENT_RUN_PAGE_LIMIT + 1,
    ...(cursor ? { before: cursor } : {}),
  });
  const available = candidates.slice(0, CLIENT_RUN_PAGE_LIMIT);
  const runs: Array<{
    runId: string;
    acceptedAt: string;
    status: StoredRunStatus;
    events: SessionEvent[];
  }> = [];
  for (const candidate of available) {
    const stored = await state.authority.readStoredRun(candidate.runId);
    if (!stored) continue;
    runs.push({
      runId: stored.runId,
      acceptedAt: stored.acceptedAt,
      status: stored.status,
      events: stored.events,
    });
  }
  const oldest = available.at(-1)?.cursor;
  return {
    schemaVersion: 1,
    runs,
    ...(candidates.length > CLIENT_RUN_PAGE_LIMIT && oldest
      ? { nextCursor: oldest }
      : {}),
  };
}
