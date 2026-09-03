/**
 * Conversations: how one Bot has more than one chat Session over its life.
 *
 * A Bot's conversational Session id was `<userId>:<botId>` forever, so its
 * durable event log only ever grew and there was no way to put a conversation
 * down and start another. A conversation numbers that Session: the first is
 * the bare id, so nothing already stored changes, and each one after it is the
 * same id with `#<ordinal>` appended.
 *
 * Starting a new conversation is a durable boundary, not a deletion. The event
 * log the next Turn derives its model request from is empty again; every Turn
 * of every earlier conversation stays in the run index under the Session id it
 * recorded, so the earlier conversation is still readable.
 */

/** The conversation a Bot's chat Session is currently on. */
export interface StoredConversationV1 {
  schemaVersion: 1;
  /** 1 is the Session every Bot starts on and the one already on disk. */
  ordinal: number;
  startedAt: string;
}

/** One conversation a Bot has had, current or ended. */
export interface ConversationRecordV1 {
  schemaVersion: 1;
  /** The Session id its Turns recorded. */
  sessionId: string;
  ordinal: number;
  startedAt: string;
  /** Absent while this is the conversation the Bot is on. */
  endedAt?: string;
}

const MAX_CONVERSATION_ORDINAL = 1_000_000;

/** The conversation a Bot with nothing stored is on. */
export function firstConversationV1(startedAt: string): StoredConversationV1 {
  return { schemaVersion: 1, ordinal: 1, startedAt };
}

export function decodeStoredConversationV1(
  input: unknown,
): StoredConversationV1 | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") {
    throw new Error("stored conversation is invalid");
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error("stored conversation.schemaVersion is invalid");
  }
  if (
    typeof value.ordinal !== "number" ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    value.ordinal > MAX_CONVERSATION_ORDINAL
  ) {
    throw new Error("stored conversation.ordinal is invalid");
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0) {
    throw new Error("stored conversation.startedAt is invalid");
  }
  return {
    schemaVersion: 1,
    ordinal: value.ordinal,
    startedAt: value.startedAt,
  };
}

export function decodeConversationRecordV1(
  input: unknown,
): ConversationRecordV1 {
  if (typeof input !== "object" || input === null) {
    throw new Error("conversation record is invalid");
  }
  const value = input as Record<string, unknown>;
  const stored = decodeStoredConversationV1({
    schemaVersion: value.schemaVersion,
    ordinal: value.ordinal,
    startedAt: value.startedAt,
  })!;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("conversation record.sessionId is invalid");
  }
  if (value.endedAt !== undefined && typeof value.endedAt !== "string") {
    throw new Error("conversation record.endedAt is invalid");
  }
  return {
    ...stored,
    sessionId: value.sessionId,
    ...(value.endedAt ? { endedAt: value.endedAt as string } : {}),
  };
}

/**
 * The Session id a Bot's chat Turns record while it is on this conversation.
 *
 * The first conversation is the bare id on purpose: every Session already
 * stored is conversation 1, so nothing has to be migrated for it to be one.
 */
export function conversationSessionIdV1(base: string, ordinal: number): string {
  return ordinal <= 1 ? base : `${base}#${ordinal}`;
}

/** The Session id a Bot's conversational Turns are addressed to. */
export function botConversationBaseSessionIdV1(identity: {
  userId: string;
  botId: string;
}): string {
  return `${identity.userId}:${identity.botId}`;
}

/**
 * True when this Session id names a conversation of that Bot — the bare base
 * id or the base id with an ordinal. A Routine firing's `routine:<id>` and a
 * subagent's Session are deliberately not conversations and never match.
 */
export function isConversationSessionIdV1(
  base: string,
  sessionId: string,
): boolean {
  if (sessionId === base) return true;
  if (!sessionId.startsWith(`${base}#`)) return false;
  return /^[1-9][0-9]{0,6}$/.test(sessionId.slice(base.length + 1));
}
