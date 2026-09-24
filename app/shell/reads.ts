// The Bot's read-only client projections: the transcript page, the
// conversation list, one run's lookup, the unprojected event page, and the
// announcement log the transcript is assembled with.

import {
  decodeSessionEvent,
  type SessionEvent,
} from "@frockbot/core/contracts";
import {
  commitPublicationsV1,
  type PublicationTransactionV1,
} from "@frockbot/core/durable";
import { announcementPublicationV1 } from "./conversation-publication.js";
import {
  optionalProjectedSendV1,
  sentAutomationRunKeyV1,
} from "@frockbot/app/notifications/storage-keys";
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
  botMessageCallV1,
  openBotQuestionsV1,
  type ClientRunListV1,
  type ClientRunLookupV1,
  type ClientRunQuestionsV1,
  type ClientRunV1,
} from "./run-protocol.js";
import {
  agentRunIdV1,
  type BotSelfManagementIdentity,
} from "./backend-flock.js";

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
  setAlarm?(scheduledTime: number): Promise<void>;
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
  const contribution = announcementPublicationV1(event);
  if (contribution) {
    await commitPublicationsV1(transaction as PublicationTransactionV1, [
      contribution,
    ]);
    await transaction.setAlarm?.(Date.now());
  }
}

/**
 * Whether the Bot is working in its own chat: the working mark on its sidebar
 * row, so somebody in another conversation can see a reply coming rather than
 * reading a quiet row as a stalled one.
 *
 * The open chat draws its working mark from the Turn its transcript shows
 * running, so the row answers by the transcript's rule or the two disagree
 * about one Bot. That is the active Turn, not the newest one: a message sent
 * while the Bot is busy is indexed at once but waits, and the chat draws it
 * queued. A Turn the chat does not show — a silent Routine firing, a member's
 * group Turn — is the Bot's work but not the chat's, so it lights nothing here
 * either.
 *
 * The record's `status` is necessary and not sufficient. `resolveRunWorking`
 * holds the rule — running, inside the Turn deadline, and a Turn the log has
 * not already closed — and only reports it; a stale record is settled by the
 * alarm's repair index, not by somebody opening the sidebar. A read that fails
 * is no mark: liveness is never worth failing a sidebar poll for.
 */
export async function chatWorkingV1(
  state: ShellBotStateV1,
  newestRunId: string | undefined,
): Promise<boolean> {
  const runId = (await state.authority.readActiveRunId()) ?? newestRunId;
  if (runId === undefined) return false;
  // The header first: it is the record without its journal, and every Bot is
  // asked on every sidebar poll while almost none of them is running.
  const header = await state.authority.readRunHeaderForDisplay(runId);
  if (!header?.readable || header.run.status !== "running") return false;
  try {
    if (!(await state.authority.resolveRunWorking(runId))) return false;
  } catch {
    return false;
  }
  const conversationId = await state.authority.readConversationSessionId();
  if (!inConversationV1(header.run, conversationId)) return false;
  // An automation Turn is in the chat only once it has spoken, and the marker
  // written beside its message is that fact.
  if (header.run.admission?.turnType === "automation") {
    return (
      (await state.ctx.storage.get(sentAutomationRunKeyV1(runId))) !== undefined
    );
  }
  return isVisibleRunV1(header.run);
}

/**
 * Whether a run belongs to the Bot's continuous chat rather than to a
 * Routine's or a child's Session. A record nobody can decode has no
 * trustworthy session id, and a transcript that hid it would be back to
 * silently losing the Turn: an unknown session belongs to the conversation
 * being read.
 */
function inConversationV1(
  run: { sessionId?: string; admission?: { turnType?: string } },
  conversationId: string | undefined,
): boolean {
  return (
    run.admission?.turnType === "automation" ||
    conversationId === undefined ||
    run.sessionId === undefined ||
    run.sessionId === conversationId
  );
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

/** Session events the announcement page needs; exact payloads stay on disk. */
const CONVERSATION_ANNOUNCEMENT_EVENT_TYPES = new Set<string>([
  "conversation/compacted",
  "turn/end",
]);

async function conversationAnnouncementEvents(
  state: ShellBotStateV1,
): Promise<SessionEvent[]> {
  const sessionId = await state.authority.readConversationSessionId();
  if (!sessionId) return [];
  return state.authority.readSessionInlineEventsOfTypes(
    sessionId,
    CONVERSATION_ANNOUNCEMENT_EVENT_TYPES,
  );
}

/**
 * The announcements as the transcript reads them, each already carrying the
 * timestamp of the place it belongs rather than the moment it was written.
 */
export async function projectAnnouncementPage(state: ShellBotStateV1) {
  const session = await conversationAnnouncementEvents(state);
  return projectClientAnnouncementsV1(
    await announcementsFromSession(state, session),
    session,
  );
}

/** The Bot's durable announcement log, including Session compaction markers. */
export async function listAnnouncements(
  state: ShellBotStateV1,
): Promise<SessionEvent[]> {
  return announcementsFromSession(
    state,
    await conversationAnnouncementEvents(state),
  );
}

export async function listRuns(
  state: ShellBotStateV1,
  input: unknown = { schemaVersion: 1 },
): Promise<ClientRunListV1> {
  const query = decodeClientRunListQueryV1(input);
  // Only the Bot’s continuous chat belongs in the transcript. Routine and
  // child sessions remain in the durable log and their own projections.
  const conversationId = await state.authority.readConversationSessionId();
  const inConversation = (run: {
    sessionId?: string;
    admission?: { turnType?: string };
  }) => inConversationV1(run, conversationId);
  // The exchange view's read: only the Turns that crossed to or from one
  // counterpart. Inbound is on the admission; outbound is a `bot_message`
  // call in the journal, so a filtered scan hydrates what it inspects. The
  // scan budget bounds it, and a page that found little still says where the
  // client resumes.
  const counterpart = query.counterpart;
  const touchesCounterpart = (
    run: Parameters<typeof projectClientRunOrDegradedV1>[0],
  ) => {
    if (!counterpart) return true;
    // A record nobody can decode names no counterpart; it is a Turn of the
    // conversation, not of an exchange.
    if (!("events" in run)) return false;
    const origin = run.admission?.origin;
    if (counterpart.kind === "voice") return origin?.kind === "voice";
    if (origin?.kind === "bot" && origin.fromBotId === counterpart.botId) {
      return true;
    }
    return run.events.some(
      (event) =>
        event.type === "tool/call" &&
        botMessageCallV1(event)?.botId === counterpart.botId,
    );
  };
  // An eviction mid-Turn leaves a readable run `running` and the alarm cleared
  // once the previous settlement finished. The transcript is the next touch,
  // and it remounts that Turn — on the turn type the admission recorded —
  // before anything is projected. A missing marker or a record nobody can
  // decode is left for this read: recovery would raise an alarm or throw, and
  // the transcript's job is to show the row.
  let activeRunId: string | undefined;
  if (!query.before) {
    activeRunId = await state.authority.readActiveRunId();
    if (activeRunId) {
      const header = await state.authority.readRunHeaderForDisplay(activeRunId);
      if (header?.readable && header.run.status === "running") {
        await state.authority.recoverActiveRun();
      }
    }
  }
  const candidates = await state.authority.listRunIndex({
    limit: CLIENT_RUN_PAGE_LIMIT + 1,
    ...(query.before ? { before: query.before } : {}),
  });
  // Announcements share the newest page's wire envelope with its Turns. Read
  // them once and budget them during selection; adding them only after the
  // page was full could push an otherwise valid transcript over the limit and
  // make every restore of that conversation answer 500.
  const announcements = query.before
    ? []
    : await projectAnnouncementPage(state);

  const selected = new Map<string, { cursor?: string; run: ClientRunV1 }>();
  if (activeRunId) {
    const active =
      await state.authority.readStoredRunForDisplayOrDegraded(activeRunId);
    // An automation firing occupies the object like any other run, and is
    // still not part of the conversation: the visible transcript never
    // shows one, running or settled.
    if (
      active &&
      isVisibleRunV1(active.run) &&
      inConversation(active.run) &&
      touchesCounterpart(active.run)
    )
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
      // An automation Turn is in the transcript only if it spoke, and the
      // marker written beside its message is that fact as one keyed read. A
      // Routine that fires every minute and says nothing is the ordinary case,
      // and hydrating each silent journal to discard it was the scan's cost.
      const admission = header?.run.admission;
      const voiceOrigin =
        admission !== undefined &&
        "origin" in admission &&
        (admission as { origin?: { kind?: string } }).origin?.kind === "voice";
      const marker =
        header?.run.admission?.turnType === "automation" || voiceOrigin
          ? await state.ctx.storage.get<unknown>(
              sentAutomationRunKeyV1(candidate.runId),
            )
          : undefined;
      const spoke =
        header?.run.admission?.turnType !== "automation" ||
        marker !== undefined;
      if (
        !header ||
        !spoke ||
        (header.run.admission?.turnType !== "automation" &&
          !isVisibleRunV1(header.run)) ||
        !inConversation(header.run)
      ) {
        scanCursor = candidate.cursor;
        continue;
      }
      const stored = await state.authority.hydrateRunForDisplay(header);
      // The marker is the durable fact that this firing contributed a message.
      // A firing that broke before it could say anything has no send event to
      // derive that from, and its message is projected below.
      if (
        (!isVisibleRunV1(stored.run) && marker === undefined) ||
        !touchesCounterpart(stored.run)
      ) {
        scanCursor = candidate.cursor;
        continue;
      }
      // The message the firing's journal could not hold is projected with the
      // run rather than appended to it, so it is budgeted with everything else
      // the page carries.
      const projected = projectClientRunOrDegradedV1(
        stored.run,
        optionalProjectedSendV1(marker),
      );
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
      const tentativePage = createClientRunListV1(
        ordered,
        {
          truncated: true,
          nextCursor: candidate.cursor,
        },
        announcements,
      );
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
    announcements,
  );
  if (clientRunListWireBytes(page) > CLIENT_RUN_LIST_MAX_BYTES) {
    throw new Error("required run projections exceed the wire byte limit");
  }
  return page;
}

/**
 * The questions a running Turn is waiting on from other Bots, and the Turn
 * answering each. Nothing here reads the other Bot: whether its Turn has
 * started is that Bot's own lookup's to say.
 */
export async function lookupRunQuestions(
  state: ShellBotStateV1,
  identity: BotSelfManagementIdentity,
  input: unknown,
): Promise<ClientRunQuestionsV1> {
  const query = decodeClientRunLookupQueryV1(input);
  const run = await state.authority.readRun(query.runId);
  const open = run && isVisibleRunV1(run) ? openBotQuestionsV1(run) : [];
  return {
    schemaVersion: 1,
    runId: query.runId,
    questions: await Promise.all(
      open.map(async (question) => ({
        callId: question.callId,
        botId: question.botId,
        runId: await agentRunIdV1(
          identity,
          query.runId,
          question.botId,
          question.occurrenceId,
        ),
      })),
    ),
  };
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
