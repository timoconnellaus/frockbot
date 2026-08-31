// The durable Channel records, and their strict codecs.
//
// Every record is versioned, exact-field, and decoded at the seam it crosses.
// There are no migrations: a record the current codec refuses is a visible
// failure rather than something to reshape.
//
// The three records are deliberately separate. A `ChannelRecordV1` is who is in
// the room; a `ChannelMessageV1` is what was said, in the order the User
// Durable Object assigned; a `ChannelDeliveryV1` is one recipient's debt for
// one message. The delivery exists so that "the message was recorded" and "the
// recipient was told" are two durable facts and not one hopeful one — the
// message and every delivery it owes are written in a single transaction, and
// the fan-out that follows can be retried without asking whether it already
// half-happened.

/** Longest values a Channel record may carry. */
export const CHANNEL_NAME_MAX = 100;
export const CHANNEL_TEXT_MAX = 8_000;
export const CHANNEL_ID_MAX = 128;
export const CHANNEL_EMOJI_MAX = 16;

/** A group Channel holds 1 to 6 Bots, and is never emptied. */
export const CHANNEL_MEMBER_MIN = 1;
export const CHANNEL_MEMBER_MAX = 6;

/**
 * How far a message may travel from the Turn a person started.
 *
 * A Bot's reply to a Channel message is itself a Channel message, so without a
 * bound two Bots would talk to each other for ever. `hop` counts the links:
 * a post from a chat Turn is 1, the reply it provokes is 2, and a post beyond
 * this is refused with a durable, visible failure.
 */
export const CHANNEL_HOP_MAX = 3;

/** The per-Channel durable token bucket: 20 messages a minute. */
export const CHANNEL_RATE_LIMIT = 20;
export const CHANNEL_RATE_WINDOW_MS = 60_000;

/** Most messages one Channel's log retains, and most a Turn's history carries. */
export const CHANNEL_MESSAGE_LOG_LIMIT = 200;
export const CHANNEL_HISTORY_LIMIT = 20;

/** Most Channels one User may hold, and most reactions one message keeps. */
export const CHANNEL_LIMIT_PER_USER = 200;
export const CHANNEL_REACTION_LIMIT = 32;

/**
 * The senses of "Channel" the register collapses into one record.
 *
 * `webui` is today's chat path — a User and one Bot — and is recorded for
 * completeness rather than produced here. `group` is 1 to 6 Bots. `external` is
 * one Bot and one remote peer, and arrives with the connector slice.
 */
export const CHANNEL_KINDS = ["webui", "group", "external"] as const;

export type ChannelKindV1 = (typeof CHANNEL_KINDS)[number];

/**
 * Who wrote a Channel record. "Every write to a durable root records its
 * writer" — a Bot writer names the Session and Turn that produced it.
 */
export type ChannelWriterV1 =
  | { kind: "user" }
  | { kind: "bot"; botId: string; sessionId: string; turnId: string };

/** One Channel. `members` holds Bot ids, in the order membership was written. */
export interface ChannelRecordV1 {
  schemaVersion: 1;
  channelId: string;
  kind: ChannelKindV1;
  name: string;
  /** The Connection an external Channel speaks through. Absent for a group. */
  connectionId?: string;
  members: string[];
  revision: number;
  /** A disconnected Channel keeps its record and its history, and takes no post. */
  active: boolean;
  createdBy: ChannelWriterV1;
  createdAt: string;
  updatedAt: string;
}

/** One emoji tapback. Idempotent on `(messageId, botId, emoji)` by construction. */
export interface ChannelReactionV1 {
  emoji: string;
  botId: string;
  at: string;
}

/**
 * One message. `seq` is assigned by the User Durable Object inside the
 * transaction that records the message, so the log has one order and no
 * producer can invent a position in it.
 */
export interface ChannelMessageV1 {
  schemaVersion: 1;
  messageId: string;
  channelId: string;
  seq: number;
  /** The Bot that posted, when a Bot did. */
  senderBotId?: string;
  /** The remote peer that posted, when an external connector delivered it. */
  senderPeer?: string;
  text: string;
  hop: number;
  at: string;
  reactions: ChannelReactionV1[];
}

/** One recipient's debt for one message. */
export interface ChannelDeliveryV1 {
  schemaVersion: 1;
  channelId: string;
  messageId: string;
  botId: string;
  state: "pending" | "admitted";
  /** The run the recipient admitted for it, once it has. */
  runId?: string;
}

export class ChannelDecodeError extends Error {
  override readonly name = "ChannelDecodeError";
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isChannelIdV1(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function channelRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function channelExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ChannelDecodeError(`${label} has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ChannelDecodeError(`${label} is missing "${key}"`);
    }
  }
}

export function channelText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new ChannelDecodeError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ChannelDecodeError(`${label} must not be empty`);
  }
  if (trimmed.length > maximum) {
    throw new ChannelDecodeError(
      `${label} must be at most ${maximum} characters`,
    );
  }
  return trimmed;
}

export function channelTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ChannelDecodeError(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function channelInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ChannelDecodeError(
      `${label} must be an integer of at least ${minimum}`,
    );
  }
  return value as number;
}

/**
 * The member list, decoded whole.
 *
 * The two rules the register states live here and nowhere else: 1 to 6 members,
 * and no duplicates. "A channel cannot be emptied" is the same rule read at the
 * lower bound, so an update that removes the last member is refused by the
 * codec rather than by a caller that might forget.
 */
export function decodeChannelMembersV1(
  value: unknown,
  label = "Channel members",
): string[] {
  if (!Array.isArray(value)) {
    throw new ChannelDecodeError(`${label} must be an array`);
  }
  if (value.length < CHANNEL_MEMBER_MIN) {
    throw new ChannelDecodeError(
      `${label} must name at least ${CHANNEL_MEMBER_MIN} Bot; a Channel is never emptied`,
    );
  }
  if (value.length > CHANNEL_MEMBER_MAX) {
    throw new ChannelDecodeError(
      `${label} must name at most ${CHANNEL_MEMBER_MAX} Bots`,
    );
  }
  const members: string[] = [];
  for (const [index, member] of value.entries()) {
    if (!isChannelIdV1(member)) {
      throw new ChannelDecodeError(`${label}[${index}] is not a Bot id`);
    }
    if (members.includes(member)) {
      throw new ChannelDecodeError(`${label} names "${member}" twice`);
    }
    members.push(member);
  }
  return members;
}

export function decodeChannelWriterV1(
  value: unknown,
  label = "Channel writer",
): ChannelWriterV1 {
  const candidate = channelRecord(value, label);
  if (candidate.kind === "user") {
    channelExactKeys(candidate, ["kind"], [], label);
    return { kind: "user" };
  }
  if (candidate.kind !== "bot") {
    throw new ChannelDecodeError(`${label} kind is invalid`);
  }
  channelExactKeys(
    candidate,
    ["kind", "botId", "sessionId", "turnId"],
    [],
    label,
  );
  return {
    kind: "bot",
    botId: channelText(candidate.botId, CHANNEL_ID_MAX, `${label} botId`),
    sessionId: channelText(candidate.sessionId, 256, `${label} sessionId`),
    turnId: channelText(candidate.turnId, 256, `${label} turnId`),
  };
}

export function decodeChannelRecordV1(
  value: unknown,
  label = "Channel record",
): ChannelRecordV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    [
      "schemaVersion",
      "channelId",
      "kind",
      "name",
      "members",
      "revision",
      "active",
      "createdBy",
      "createdAt",
      "updatedAt",
    ],
    ["connectionId"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  const kind = CHANNEL_KINDS.find((known) => known === candidate.kind);
  if (!kind) throw new ChannelDecodeError(`${label} kind is invalid`);
  if (typeof candidate.active !== "boolean") {
    throw new ChannelDecodeError(`${label} active must be a boolean`);
  }
  return {
    schemaVersion: 1,
    channelId: candidate.channelId,
    kind,
    name: channelText(candidate.name, CHANNEL_NAME_MAX, `${label} name`),
    members: decodeChannelMembersV1(candidate.members, `${label} members`),
    revision: channelInteger(candidate.revision, `${label} revision`),
    active: candidate.active,
    createdBy: decodeChannelWriterV1(candidate.createdBy, `${label} createdBy`),
    createdAt: channelTimestamp(candidate.createdAt, `${label} createdAt`),
    updatedAt: channelTimestamp(candidate.updatedAt, `${label} updatedAt`),
    ...(candidate.connectionId === undefined
      ? {}
      : {
          connectionId: channelText(
            candidate.connectionId,
            CHANNEL_ID_MAX,
            `${label} connectionId`,
          ),
        }),
  };
}

function decodeChannelReactionV1(
  value: unknown,
  label: string,
): ChannelReactionV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(candidate, ["emoji", "botId", "at"], [], label);
  return {
    emoji: channelText(candidate.emoji, CHANNEL_EMOJI_MAX, `${label} emoji`),
    botId: channelText(candidate.botId, CHANNEL_ID_MAX, `${label} botId`),
    at: channelTimestamp(candidate.at, `${label} at`),
  };
}

export function decodeChannelMessageV1(
  value: unknown,
  label = "Channel message",
): ChannelMessageV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    [
      "schemaVersion",
      "messageId",
      "channelId",
      "seq",
      "text",
      "hop",
      "at",
      "reactions",
    ],
    ["senderBotId", "senderPeer"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isChannelIdV1(candidate.messageId)) {
    throw new ChannelDecodeError(`${label} messageId is invalid`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  // A message has exactly one sender. Neither would be a message from nobody;
  // both would be a message the thread could attribute two ways.
  const fromBot = candidate.senderBotId !== undefined;
  const fromPeer = candidate.senderPeer !== undefined;
  if (fromBot === fromPeer) {
    throw new ChannelDecodeError(
      `${label} must name exactly one of senderBotId and senderPeer`,
    );
  }
  if (!Array.isArray(candidate.reactions)) {
    throw new ChannelDecodeError(`${label} reactions must be an array`);
  }
  if (candidate.reactions.length > CHANNEL_REACTION_LIMIT) {
    throw new ChannelDecodeError(
      `${label} carries more than ${CHANNEL_REACTION_LIMIT} reactions`,
    );
  }
  const hop = channelInteger(candidate.hop, `${label} hop`, 1);
  return {
    schemaVersion: 1,
    messageId: candidate.messageId,
    channelId: candidate.channelId,
    seq: channelInteger(candidate.seq, `${label} seq`),
    text: channelText(candidate.text, CHANNEL_TEXT_MAX, `${label} text`),
    hop,
    at: channelTimestamp(candidate.at, `${label} at`),
    reactions: candidate.reactions.map((reaction, index) =>
      decodeChannelReactionV1(reaction, `${label} reactions[${index}]`),
    ),
    ...(fromBot
      ? {
          senderBotId: channelText(
            candidate.senderBotId,
            CHANNEL_ID_MAX,
            `${label} senderBotId`,
          ),
        }
      : {}),
    ...(fromPeer
      ? {
          senderPeer: channelText(
            candidate.senderPeer,
            CHANNEL_ID_MAX,
            `${label} senderPeer`,
          ),
        }
      : {}),
  };
}

export function decodeChannelDeliveryV1(
  value: unknown,
  label = "Channel delivery",
): ChannelDeliveryV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "channelId", "messageId", "botId", "state"],
    ["runId"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.state !== "pending" && candidate.state !== "admitted") {
    throw new ChannelDecodeError(`${label} state is invalid`);
  }
  if (!isChannelIdV1(candidate.channelId)) {
    throw new ChannelDecodeError(`${label} channelId is invalid`);
  }
  if (!isChannelIdV1(candidate.messageId)) {
    throw new ChannelDecodeError(`${label} messageId is invalid`);
  }
  return {
    schemaVersion: 1,
    channelId: candidate.channelId,
    messageId: candidate.messageId,
    botId: channelText(candidate.botId, CHANNEL_ID_MAX, `${label} botId`),
    state: candidate.state,
    ...(candidate.runId === undefined
      ? {}
      : { runId: channelText(candidate.runId, 256, `${label} runId`) }),
  };
}

/**
 * The implicit 1:1 Channel two Bots share.
 *
 * `send_to_agent` with a bare `botId` resolves to it, so a Bot can address a
 * teammate without either of them having created anything. The id is derived
 * from the pair and sorted, so both directions name the same Channel and no
 * command has to look one up before it can be written.
 */
export function pairChannelIdV1(left: string, right: string): string {
  if (!isChannelIdV1(left) || !isChannelIdV1(right)) {
    throw new ChannelDecodeError("a pair Channel needs two Bot ids");
  }
  if (left === right) {
    throw new ChannelDecodeError("a Bot has no pair Channel with itself");
  }
  const [first, second] = [left, right].sort();
  const id = `pair-${first}--${second}`;
  if (!isChannelIdV1(id)) {
    throw new ChannelDecodeError(
      "the implicit pair Channel id for these Bots is too long to record",
    );
  }
  return id;
}
