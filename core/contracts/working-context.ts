// Explicit Session seed. A Turn is not started from a slice of the archive
// pretending to be the whole log: sequence and Turn numbers stay absolute,
// and a missing prefix is not an empty history.
import type { SendToUserPayloadV1 } from "./send-to-user.js";
import type { LlmMessage, SessionEvent, TurnTypeV1 } from "./types.js";

export const WORKING_CONTEXT_SCHEMA_VERSION_V1 = 1 as const;

/** Where the next event and the next Turn are allocated. */
export interface SessionCursorV1 {
  sessionId: string;
  /** Bumped when the log is replaced. A compaction commit for an older epoch is stale. */
  epoch: number;
  /** Absolute sequence of the next event. Not an array length. */
  nextSeq: number;
  /** Absolute number of the next Turn. Not discovered by scanning the archive. */
  nextTurn: number;
}

/**
 * One committed Turn's normalized messages, complete.
 *
 * Pages may split the bytes; a reader reassembles them. Nothing here is a
 * truncated stand-in for events that were not selected.
 */
export interface CommittedTurnContextV1 {
  turn: number;
  turnType: TurnTypeV1 | "unspecified";
  /** Inclusive start sequence of the Turn's events. */
  startSeq: number;
  /** Exclusive end sequence. */
  endSeq: number;
  messages: readonly LlmMessage[];
  fullChars: number;
  prunedChars: number;
  messageBearing: boolean;
}

/** Summary standing in for a covered prefix, plus the Turns selected after it. */
export interface CommittedContextV1 {
  summary?: {
    effectId: string;
    fromTurn: number;
    throughTurn: number;
    throughSeq: number;
    summary: string;
    identifiers: readonly string[];
    provider: string;
    model: string;
    sourceEpoch: number;
    sourceRevision: number;
  };
  /** Selected complete Turns, oldest first. The open Turn is not one of these. */
  turns: readonly CommittedTurnContextV1[];
  /** Message-bearing chat Turns left out of `turns` by the budget. */
  omittedTurns: number;
}

/**
 * Exact events of the run that is executing or being recovered.
 *
 * The journal may be large. It is never a cap on the current run, and it is
 * never a substitute for older runs.
 */
export interface ActiveRunJournalV1 {
  /** Absolute sequence of `events[0]`, or `cursor.nextSeq` when `events` is empty. */
  startSeq: number;
  events: readonly SessionEvent[];
}

/**
 * What a new or resumed Turn is given. `journal` is not `previousEvents`.
 */
export interface SessionSeedV1 {
  cursor: SessionCursorV1;
  context: CommittedContextV1;
  journal: ActiveRunJournalV1;
}

/**
 * History, audit, and recovery read the archive only through an explicit
 * half-open range with a count limit. A method that returns the whole log
 * is not an implementation of this.
 */
export interface ArchiveRangeV1 {
  sessionId: string;
  startSeq: number;
  /** Exclusive. */
  endSeq: number;
  /** Maximum events to return. Callers that need more ask for the next range. */
  limit: number;
}

export interface ArchiveReaderV1 {
  readRange(range: ArchiveRangeV1): Promise<readonly { seq: number }[]>;
}

export interface ConversationHeadV1 {
  schemaVersion: typeof WORKING_CONTEXT_SCHEMA_VERSION_V1;
  sessionId: string;
  epoch: number;
  nextSeq: number;
  nextTurn: number;
  revision: number;
  /** Exclusive. Events before this sequence are reflected in the projection. */
  projectedThroughSeq: number;
  chatTurnCount: number;
  messageBearingChatTurns: number;
  /**
   * `ready` has turn pages. `cursor` only tracks sequence, so a model request
   * must not be assembled from it. `unavailable` is a recorded repair.
   */
  status: "ready" | "cursor" | "unavailable";
  unavailableReason?: string;
  openTurn?: number;
  openRunId?: string;
  compaction?: CommittedContextV1["summary"] & {
    coveredMessageBearingTurns: number;
  };
  unsettledCompaction?: { effectId: string; throughTurn: number };
  compactionFailures: number;
  lastFailureThroughTurn: number;
}

export interface TurnOccurrenceV1 {
  callId: string;
  name: string;
  nested: boolean;
}

export interface TurnContextIndexV1 {
  schemaVersion: typeof WORKING_CONTEXT_SCHEMA_VERSION_V1;
  sessionId: string;
  turn: number;
  turnType: TurnTypeV1 | "unspecified";
  startSeq: number;
  endSeq: number;
  fullChars: number;
  prunedChars: number;
  messageBearing: boolean;
  /** Message-bearing chat Turns up to and including this one, when it counts. */
  chatOrdinal: number;
  /** The Turn has been added to the head's chat Turn count. */
  counted: boolean;
  pageCount: number;
  occurrences: Record<string, TurnOccurrenceV1>;
}

/** A message larger than a page is stored beside it and reassembled exactly. */
export interface ChunkedMessageRefV1 {
  storage: "chunked";
  bytes: number;
  sha256: string;
  chunks: number;
}

export type StoredContextMessageV1 = LlmMessage | ChunkedMessageRefV1;

export interface WorkingContextPageV1 {
  schemaVersion: typeof WORKING_CONTEXT_SCHEMA_VERSION_V1;
  sessionId: string;
  turn: number;
  page: number;
  messages: StoredContextMessageV1[];
}

export interface VoiceExcerptLineV1 {
  role: "user" | "assistant";
  text: string;
  turn: number;
  seq: number;
  at: string;
  runId?: string;
  to?: "user" | "voice" | "bot";
}

export interface VoiceExcerptV1 {
  schemaVersion: typeof WORKING_CONTEXT_SCHEMA_VERSION_V1;
  sessionId: string;
  lines: VoiceExcerptLineV1[];
}

/**
 * Loads the committed context for one request. The active Turn's messages are
 * passed in; the selector must not read the archive to find them.
 */
export interface WorkingContextRequestV1 {
  sessionId: string;
  epoch: number;
  currentTurn: number;
  currentTurnType: TurnTypeV1 | "unspecified";
  currentMessages: readonly LlmMessage[];
  budget?: number;
  pointer?(input: { sessionId: string; chatTurns: number }): string;
}

export type WorkingContextSelectorV1 = (
  request: WorkingContextRequestV1,
) => Promise<LlmMessage[]>;

export function emptyCommittedContextV1(): CommittedContextV1 {
  return { turns: [], omittedTurns: 0 };
}

export function emptyConversationHeadV1(sessionId: string): ConversationHeadV1 {
  return {
    schemaVersion: WORKING_CONTEXT_SCHEMA_VERSION_V1,
    sessionId,
    epoch: 1,
    nextSeq: 0,
    nextTurn: 1,
    revision: 0,
    projectedThroughSeq: 0,
    chatTurnCount: 0,
    messageBearingChatTurns: 0,
    status: "ready",
    compactionFailures: 0,
    lastFailureThroughTurn: 0,
  };
}

export function isChunkedMessageRefV1(
  message: StoredContextMessageV1,
): message is ChunkedMessageRefV1 {
  return (
    typeof message === "object" &&
    message !== null &&
    "storage" in message &&
    message.storage === "chunked"
  );
}

/** Visible text of one explicit send. Model scratch is not a send. */
export function visibleSendTextV1(payload: SendToUserPayloadV1): string {
  switch (payload.type) {
    case "text":
      return payload.text;
    case "attachment":
      return `Shared attachment: ${payload.name ?? payload.mediaType ?? "file"}`;
    case "widget":
      return `Asked: ${payload.widget.prompt}`;
    case "secret-request":
      return `Requested a secret: ${payload.prompt}`;
    case "agent-card":
      return `${payload.title}${payload.body ? `: ${payload.body}` : ""}`;
    case "approval":
      return `Approval requested: ${payload.action}`;
    case "applet":
      return `Shared applet: ${payload.appletId}`;
    case "card":
      return `Showed a card: ${payload.surfaceId}`;
  }
}
