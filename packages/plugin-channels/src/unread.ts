// Per-Channel unread, and the read position the User writes.
//
// A Bot's unread badge is Bot-scoped and derived from that Bot's own admission
// index (`@frockbot/plugin-shell/unread`). A Channel's is not: a Channel's
// message log, its `seq` and the deliveries it owes are User-scoped and live
// beside the record in the User Durable Object, so the position the User has
// read to lives there too and is derived from nothing the Bot Durable Object
// holds.
//
// The rule, from the accepted plan: a Channel row is unread while any delivery
// for the viewing User is still `pending`, or while a message sits above the
// last-read `seq`. The first clause is why a room whose Bots have not answered
// yet still reads as live after the User has scrolled it; the second is the
// ordinary one.
//
// The read position is a cursor, not a counter. `max()` over a `seq` is
// idempotent, so an out-of-order or replayed `channel/mark-read` cannot move
// the badge backwards and cannot double-count — the same reason PR #65 stores
// cursors rather than counts.
import {
  canonicalCommandFingerprintV1,
  isPublicIdentifier,
} from "@frockbot/configuration-core";
import {
  channelExactKeys,
  channelRecord,
  ChannelDecodeError,
  isChannelIdV1,
} from "./records.js";

/** Everything past this is reported as "99+"; a row never renders more. */
export const CHANNEL_UNREAD_COUNT_CAP = 99;

/**
 * How many of a Channel's newest messages the pending scan looks at.
 *
 * A delivery is keyed by its message, so "any delivery is pending" is a read
 * per message. The bound keeps one poll's cost proportional to what a person
 * could plausibly be behind on rather than to the whole bounded log.
 */
export const CHANNEL_UNREAD_PENDING_SCAN = 10;

/** How many Channels one unread fan-out answers for. */
export const CHANNEL_UNREAD_FANOUT_LIMIT = 50;

/** The durable read position, one record per Channel. */
export interface ChannelReadCursorV1 {
  schemaVersion: 1;
  channelId: string;
  /** The highest `seq` the User has read. Absent means nothing was read. */
  lastReadSeq: number;
  at: string;
}

/**
 * What a Channel row renders. Everything here is derived on read: only
 * `lastReadSeq` is stored, and it is stored because nothing derives it.
 */
export interface ChannelUnreadViewV1 {
  schemaVersion: 1;
  channelId: string;
  /** Messages above `lastReadSeq`, capped at {@link CHANNEL_UNREAD_COUNT_CAP}. */
  count: number;
  capped: boolean;
  /** A delivery this Channel owes that no recipient has admitted yet. */
  pending: boolean;
  /** Whether the row renders bold: a count, or a delivery still in flight. */
  unread: boolean;
  /** What a `channel/mark-read` should name as `upToSeq`. */
  lastSeq?: number;
  lastReadSeq?: number;
  lastMessageAt?: string;
}

export interface ChannelUnreadDirectoryViewV1 {
  schemaVersion: 1;
  botId: string;
  unread: ChannelUnreadViewV1[];
}

/**
 * An authenticated command, never a side effect of a read: a background poll
 * that listed a thread must not clear a badge.
 */
export interface ChannelReadCommandV1 {
  schemaVersion: 1;
  type: "channel/mark-read";
  commandId: string;
  channelId: string;
  upToSeq: number;
}

export interface ChannelReadReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied";
  unread: ChannelUnreadViewV1;
}

function commandId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ChannelDecodeError(`${label} is invalid`);
  }
  return value;
}

function sequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChannelDecodeError(`${label} is invalid`);
  }
  return value as number;
}

export function decodeChannelReadCursorV1(
  value: unknown,
  label = "Channel read cursor",
): ChannelReadCursorV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "channelId", "lastReadSeq", "at"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  if (typeof candidate.at !== "string" || candidate.at.length > 64) {
    throw new ChannelDecodeError(`${label} at is invalid`);
  }
  return {
    schemaVersion: 1,
    channelId: candidate.channelId,
    lastReadSeq: sequence(candidate.lastReadSeq, `${label} lastReadSeq`),
    at: candidate.at,
  };
}

/**
 * Record that the User read up to a `seq`. Monotonic: a cursor that is not
 * newer leaves the record byte-for-byte unchanged, so a replayed command
 * cannot move the badge and an out-of-order one cannot undo a later read.
 */
export function advanceChannelReadCursorV1(
  current: ChannelReadCursorV1 | undefined,
  input: { channelId: string; upToSeq: number; at: string },
): ChannelReadCursorV1 {
  if (current !== undefined && current.lastReadSeq >= input.upToSeq) {
    return current;
  }
  return {
    schemaVersion: 1,
    channelId: input.channelId,
    lastReadSeq: input.upToSeq,
    at: input.at,
  };
}

/**
 * The projection a Channel row renders, from the Channel's own log.
 *
 * `messages` is the newest window of the Channel's bounded log, oldest first.
 * `pendingMessageIds` names the messages inside that window that still owe a
 * recipient a Turn. Nothing here reads storage: the caller has already paid
 * for both, and this is the rule they are folded under.
 */
export function projectChannelUnreadViewV1(
  channelId: string,
  input: {
    messages: readonly { seq: number; at: string; messageId: string }[];
    pendingMessageIds?: readonly string[];
    cursor?: ChannelReadCursorV1;
  },
): ChannelUnreadViewV1 {
  const lastReadSeq = input.cursor?.lastReadSeq;
  const newest = input.messages.at(-1);
  const above = input.messages.filter(
    (message) => lastReadSeq === undefined || message.seq > lastReadSeq,
  );
  const capped = above.length > CHANNEL_UNREAD_COUNT_CAP;
  const count = capped ? CHANNEL_UNREAD_COUNT_CAP : above.length;
  const pending = (input.pendingMessageIds ?? []).length > 0;
  return {
    schemaVersion: 1,
    channelId,
    count,
    capped,
    pending,
    unread: count > 0 || pending,
    ...(newest === undefined ? {} : { lastSeq: newest.seq }),
    ...(newest === undefined ? {} : { lastMessageAt: newest.at }),
    ...(lastReadSeq === undefined ? {} : { lastReadSeq }),
  };
}

export function decodeChannelReadCommandV1(
  value: unknown,
  label = "Channel read command",
): ChannelReadCommandV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "type", "commandId", "channelId", "upToSeq"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.type !== "channel/mark-read") {
    throw new ChannelDecodeError(`${label} type is unknown`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  return {
    schemaVersion: 1,
    type: "channel/mark-read",
    commandId: commandId(candidate.commandId, `${label} commandId`),
    channelId: candidate.channelId,
    upToSeq: sequence(candidate.upToSeq, `${label} upToSeq`),
  };
}

/** The same canonicalization every other command family is fingerprinted with. */
export function channelReadCommandFingerprintV1(
  command: ChannelReadCommandV1,
): string {
  const { commandId: _commandId, ...semantic } = command;
  return canonicalCommandFingerprintV1("channel-read-command-v1", semantic);
}

export function decodeChannelUnreadViewV1(
  value: unknown,
  label = "Channel unread view",
): ChannelUnreadViewV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "channelId", "count", "capped", "pending", "unread"],
    ["lastSeq", "lastReadSeq", "lastMessageAt"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  if (
    !Number.isSafeInteger(candidate.count) ||
    (candidate.count as number) < 0 ||
    (candidate.count as number) > CHANNEL_UNREAD_COUNT_CAP
  ) {
    throw new ChannelDecodeError(`${label} count is invalid`);
  }
  if (
    typeof candidate.capped !== "boolean" ||
    typeof candidate.pending !== "boolean" ||
    typeof candidate.unread !== "boolean"
  ) {
    throw new ChannelDecodeError(`${label} flags are invalid`);
  }
  if (
    candidate.lastMessageAt !== undefined &&
    (typeof candidate.lastMessageAt !== "string" ||
      candidate.lastMessageAt.length > 64)
  ) {
    throw new ChannelDecodeError(`${label} lastMessageAt is invalid`);
  }
  return {
    schemaVersion: 1,
    channelId: candidate.channelId,
    count: candidate.count as number,
    capped: candidate.capped,
    pending: candidate.pending,
    unread: candidate.unread,
    ...(candidate.lastSeq === undefined
      ? {}
      : { lastSeq: sequence(candidate.lastSeq, `${label} lastSeq`) }),
    ...(candidate.lastReadSeq === undefined
      ? {}
      : {
          lastReadSeq: sequence(candidate.lastReadSeq, `${label} lastReadSeq`),
        }),
    ...(candidate.lastMessageAt === undefined
      ? {}
      : { lastMessageAt: candidate.lastMessageAt as string }),
  };
}

export function decodeChannelUnreadDirectoryViewV1(
  value: unknown,
  label = "Channel unread directory",
): ChannelUnreadDirectoryViewV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(candidate, ["schemaVersion", "botId", "unread"], [], label);
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    typeof candidate.botId !== "string" ||
    !isPublicIdentifier(candidate.botId)
  ) {
    throw new ChannelDecodeError(`${label} botId is invalid`);
  }
  if (!Array.isArray(candidate.unread)) {
    throw new ChannelDecodeError(`${label} unread must be an array`);
  }
  return {
    schemaVersion: 1,
    botId: candidate.botId,
    unread: candidate.unread.map((view, index) =>
      decodeChannelUnreadViewV1(view, `${label} unread[${index}]`),
    ),
  };
}

export function decodeChannelReadReceiptV1(
  value: unknown,
  label = "Channel read receipt",
): ChannelReadReceiptV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "commandId", "status", "unread"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1 || candidate.status !== "applied") {
    throw new ChannelDecodeError(`${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    commandId: commandId(candidate.commandId, `${label} commandId`),
    status: "applied",
    unread: decodeChannelUnreadViewV1(candidate.unread, `${label} unread`),
  };
}
