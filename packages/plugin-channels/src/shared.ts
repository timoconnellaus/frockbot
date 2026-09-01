// The Channel wire: commands, receipts, and the views a projection carries.
//
// One command path. The `send_to_agent`, `react_to_message` and
// `channel_manage` tools, the fan-out the Bot Durable Object retries, and — in
// a later slice — the hosted client all reach the durable record through
// `ChannelStore.execute` and through nothing else, so a Bot writing a Channel
// and a User writing one produce the same record with different recorded
// provenance.
//
// Every command carries a `commandId`, and its receipt is durable and
// fingerprinted: a retried command replays its recorded outcome, and a reused
// id carrying different bytes is an error rather than a silent second write.
//
// A refusal is a receipt, not an exception. Hop, quota and membership are the
// three bounds a Channel is allowed to say no on, and the constitution wants a
// refusal recorded where it can be read back rather than raised into a caller
// that may or may not write it down.
import { canonicalCommandFingerprintV1 } from "@frockbot/configuration-core";
import {
  channelExactKeys,
  channelRecord,
  channelText,
  ChannelDecodeError,
  CHANNEL_EMOJI_MAX,
  CHANNEL_ID_MAX,
  CHANNEL_NAME_MAX,
  CHANNEL_TEXT_MAX,
  decodeChannelMembersV1,
  decodeChannelRecordV1,
  isChannelIdV1,
  type ChannelKindV1,
  type ChannelMessageV1,
  type ChannelReactionV1,
  type ChannelRecordV1,
} from "./records.js";

export const CHANNEL_COMMAND_TYPES = [
  "channel/create",
  "channel/update",
  "channel/disconnect",
  "channel/post",
  "channel/react",
] as const;

export type ChannelCommandTypeV1 = (typeof CHANNEL_COMMAND_TYPES)[number];

interface ChannelCommandMetaV1 {
  schemaVersion: 1;
  commandId: string;
  /** The Bot acting. Membership and the sender-is-never-a-recipient rule use it. */
  botId: string;
}

export type ChannelCommandV1 =
  | (ChannelCommandMetaV1 & {
      type: "channel/create";
      /** Absent lets the store mint one; a tool supplies a deterministic id. */
      channelId?: string;
      name: string;
      members: string[];
      /** Absent is `group`. An `external` Channel is one Bot and one peer. */
      kind?: Exclude<ChannelKindV1, "webui">;
      /** The Connection an external Channel speaks through. */
      connectionId?: string;
    })
  | (ChannelCommandMetaV1 & {
      type: "channel/update";
      channelId: string;
      name?: string;
      addMemberIds?: string[];
      removeMemberIds?: string[];
    })
  | (ChannelCommandMetaV1 & {
      type: "channel/disconnect";
      channelId: string;
    })
  | (ChannelCommandMetaV1 & {
      type: "channel/post";
      channelId: string;
      /** Absent lets the store derive one from the command id. */
      messageId?: string;
      text: string;
      /** The hop this post is at. Absent is 1: a post from a chat Turn. */
      hop?: number;
      /**
       * The remote peer that said it, when a connector delivered this post.
       * A peer is not a member, so `botId` still names the Channel member whose
       * authority the write runs under, and the post *is* owed to that member:
       * the sender-is-never-a-recipient rule is about Bots, not about peers.
       */
      senderPeer?: string;
    })
  | (ChannelCommandMetaV1 & {
      type: "channel/react";
      channelId: string;
      messageId: string;
      emoji: string;
    });

export interface ChannelViewV1 {
  schemaVersion: 1;
  channelId: string;
  kind: ChannelKindV1;
  name: string;
  members: string[];
  revision: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  connectionId?: string;
}

export interface ChannelListViewV1 {
  schemaVersion: 1;
  botId: string;
  channels: ChannelViewV1[];
}

export interface ChannelMessageViewV1 {
  schemaVersion: 1;
  messageId: string;
  channelId: string;
  seq: number;
  senderBotId?: string;
  senderPeer?: string;
  text: string;
  hop: number;
  at: string;
  reactions: ChannelReactionV1[];
}

export interface ChannelThreadViewV1 {
  schemaVersion: 1;
  channelId: string;
  messages: ChannelMessageViewV1[];
}

/**
 * One Channel, as the hosted client renders it: the record, the members strip,
 * the thread, and — for an external Channel — the *label* of the Connection it
 * speaks through.
 *
 * The label, and nothing else. A Connection's credential material never leaves
 * the backend, so what the WebUI is told about a connected Channel is the name
 * a person gave it and the platform it belongs to.
 */
export interface ChannelThreadPageViewV1 {
  schemaVersion: 1;
  channel: ChannelViewV1;
  messages: ChannelMessageViewV1[];
  /** The Connection's human label. Never a token, a digest or a webhook path. */
  connectionLabel?: string;
  /** The platform an external Channel speaks to, when it is one. */
  platform?: string;
}

/** Why a Channel command was refused. Each is a bound the register states. */
export const CHANNEL_REFUSALS = [
  "unknown-channel",
  "not-a-member",
  "membership",
  "inactive",
  "hop",
  "quota",
  "unknown-message",
] as const;

export type ChannelRefusalV1 = (typeof CHANNEL_REFUSALS)[number];

export type ChannelCommandReceiptV1 =
  | {
      schemaVersion: 1;
      commandId: string;
      status: "applied";
      channel: ChannelViewV1;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "posted";
      channel: ChannelViewV1;
      message: ChannelMessageViewV1;
      /** The Bots this post owes a `channel` Turn, in member order. */
      recipients: string[];
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "reacted";
      channelId: string;
      messageId: string;
      emoji: string;
      botId: string;
      /** False when the same Bot had already reacted with the same emoji. */
      added: boolean;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "refused";
      refusal: ChannelRefusalV1;
      reason: string;
    };

/**
 * The command's identity, less its idempotency key: two commands that differ
 * only by `commandId` are the same command, and a `commandId` reused with
 * different bytes is the error the receipt catches.
 */
export function channelCommandFingerprintV1(command: ChannelCommandV1): string {
  const { commandId: _commandId, ...semantic } = command;
  return canonicalCommandFingerprintV1("channel-command-v1", semantic);
}

export function channelViewV1(record: ChannelRecordV1): ChannelViewV1 {
  return {
    schemaVersion: 1,
    channelId: record.channelId,
    kind: record.kind,
    name: record.name,
    members: [...record.members],
    revision: record.revision,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.connectionId === undefined
      ? {}
      : { connectionId: record.connectionId }),
  };
}

export function channelMessageViewV1(
  message: ChannelMessageV1,
): ChannelMessageViewV1 {
  return {
    schemaVersion: 1,
    messageId: message.messageId,
    channelId: message.channelId,
    seq: message.seq,
    text: message.text,
    hop: message.hop,
    at: message.at,
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
    ...(message.senderBotId === undefined
      ? {}
      : { senderBotId: message.senderBotId }),
    ...(message.senderPeer === undefined
      ? {}
      : { senderPeer: message.senderPeer }),
  };
}

function commandIdentifier(value: unknown, label: string): string {
  if (!isChannelIdV1(value)) {
    throw new ChannelDecodeError(`${label} is invalid`);
  }
  return value;
}

function optionalMembers(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ChannelDecodeError(`${label} must be an array`);
  }
  const members: string[] = [];
  for (const [index, member] of value.entries()) {
    if (!isChannelIdV1(member)) {
      throw new ChannelDecodeError(`${label}[${index}] is not a Bot id`);
    }
    if (!members.includes(member)) members.push(member);
  }
  return members;
}

export function decodeChannelCommandV1(value: unknown): ChannelCommandV1 {
  const candidate = channelRecord(value, "Channel command");
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(
      "Channel command schemaVersion is unsupported",
    );
  }
  const type = CHANNEL_COMMAND_TYPES.find((known) => known === candidate.type);
  if (!type) {
    throw new ChannelDecodeError("Channel command type is unknown");
  }
  const meta: ChannelCommandMetaV1 = {
    schemaVersion: 1,
    commandId: commandIdentifier(
      candidate.commandId,
      "Channel command commandId",
    ),
    botId: commandIdentifier(candidate.botId, "Channel command botId"),
  };
  if (type === "channel/create") {
    channelExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "name", "members"],
      ["channelId", "kind", "connectionId"],
      "channel/create",
    );
    if (
      candidate.kind !== undefined &&
      candidate.kind !== "group" &&
      candidate.kind !== "external"
    ) {
      throw new ChannelDecodeError("channel/create kind is unsupported");
    }
    if (candidate.kind === "external" && candidate.connectionId === undefined) {
      throw new ChannelDecodeError(
        "an external Channel names the Connection it speaks through",
      );
    }
    if (candidate.kind !== "external" && candidate.connectionId !== undefined) {
      throw new ChannelDecodeError(
        "only an external Channel names a Connection",
      );
    }
    return {
      ...meta,
      type,
      name: channelText(candidate.name, CHANNEL_NAME_MAX, "channel name"),
      members: decodeChannelMembersV1(candidate.members),
      ...(candidate.channelId === undefined
        ? {}
        : {
            channelId: commandIdentifier(candidate.channelId, "channelId"),
          }),
      ...(candidate.kind === undefined
        ? {}
        : { kind: candidate.kind as "group" | "external" }),
      ...(candidate.connectionId === undefined
        ? {}
        : {
            connectionId: commandIdentifier(
              candidate.connectionId,
              "connectionId",
            ),
          }),
    };
  }
  if (type === "channel/update") {
    channelExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "channelId"],
      ["name", "addMemberIds", "removeMemberIds"],
      "channel/update",
    );
    const add = optionalMembers(candidate.addMemberIds, "addMemberIds");
    const remove = optionalMembers(
      candidate.removeMemberIds,
      "removeMemberIds",
    );
    if (
      candidate.name === undefined &&
      (add?.length ?? 0) === 0 &&
      (remove?.length ?? 0) === 0
    ) {
      throw new ChannelDecodeError("channel/update changes nothing");
    }
    return {
      ...meta,
      type,
      channelId: commandIdentifier(candidate.channelId, "channelId"),
      ...(candidate.name === undefined
        ? {}
        : {
            name: channelText(candidate.name, CHANNEL_NAME_MAX, "channel name"),
          }),
      ...(add === undefined ? {} : { addMemberIds: add }),
      ...(remove === undefined ? {} : { removeMemberIds: remove }),
    };
  }
  if (type === "channel/disconnect") {
    channelExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "channelId"],
      [],
      "channel/disconnect",
    );
    return {
      ...meta,
      type,
      channelId: commandIdentifier(candidate.channelId, "channelId"),
    };
  }
  if (type === "channel/post") {
    channelExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "channelId", "text"],
      ["messageId", "hop", "senderPeer"],
      "channel/post",
    );
    if (
      candidate.hop !== undefined &&
      (!Number.isSafeInteger(candidate.hop) || (candidate.hop as number) < 1)
    ) {
      throw new ChannelDecodeError("channel/post hop must be at least 1");
    }
    return {
      ...meta,
      type,
      channelId: commandIdentifier(candidate.channelId, "channelId"),
      text: channelText(candidate.text, CHANNEL_TEXT_MAX, "channel text"),
      ...(candidate.messageId === undefined
        ? {}
        : {
            messageId: commandIdentifier(candidate.messageId, "messageId"),
          }),
      ...(candidate.hop === undefined ? {} : { hop: candidate.hop as number }),
      ...(candidate.senderPeer === undefined
        ? {}
        : {
            senderPeer: channelText(
              candidate.senderPeer,
              CHANNEL_ID_MAX,
              "senderPeer",
            ),
          }),
    };
  }
  channelExactKeys(
    candidate,
    [
      "schemaVersion",
      "type",
      "commandId",
      "botId",
      "channelId",
      "messageId",
      "emoji",
    ],
    [],
    "channel/react",
  );
  return {
    ...meta,
    type: "channel/react",
    channelId: commandIdentifier(candidate.channelId, "channelId"),
    messageId: commandIdentifier(candidate.messageId, "messageId"),
    emoji: channelText(candidate.emoji, CHANNEL_EMOJI_MAX, "reaction emoji"),
  };
}

/**
 * One durable input a Channel message owes one recipient.
 *
 * It crosses the User Durable Object → Bot Durable Object seam, so it carries
 * everything the recipient needs to admit its own `channel` Turn without
 * reading anything back: the message that provoked it, the hop it is at, and
 * the Channel's recent history, which is the Turn's whole model context.
 */
export interface ChannelInputV1 {
  schemaVersion: 1;
  channelId: string;
  channelName: string;
  messageId: string;
  botId: string;
  senderBotId?: string;
  senderPeer?: string;
  text: string;
  hop: number;
  at: string;
  /** The Channel's last messages, oldest first, this message included. */
  history: ChannelMessageViewV1[];
  /**
   * Whether this Channel speaks to a remote platform.
   *
   * The recipient needs it to know what its own `send_to_user` means: in an
   * external Channel a send is carried to a person on another service, and in a
   * group Channel it is recorded and reaches nobody. Absent is a group.
   */
  external?: boolean;
}

export function decodeChannelInputV1(
  value: unknown,
  label = "Channel input",
): ChannelInputV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    [
      "schemaVersion",
      "channelId",
      "channelName",
      "messageId",
      "botId",
      "text",
      "hop",
      "at",
      "history",
    ],
    ["senderBotId", "senderPeer", "external"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    candidate.external !== undefined &&
    typeof candidate.external !== "boolean"
  ) {
    throw new ChannelDecodeError(`${label} external must be a boolean`);
  }
  if (!Number.isSafeInteger(candidate.hop) || (candidate.hop as number) < 1) {
    throw new ChannelDecodeError(`${label} hop must be at least 1`);
  }
  if (!Array.isArray(candidate.history)) {
    throw new ChannelDecodeError(`${label} history must be an array`);
  }
  return {
    schemaVersion: 1,
    channelId: commandIdentifier(candidate.channelId, `${label} channelId`),
    channelName: channelText(
      candidate.channelName,
      CHANNEL_NAME_MAX,
      `${label} channelName`,
    ),
    messageId: commandIdentifier(candidate.messageId, `${label} messageId`),
    botId: commandIdentifier(candidate.botId, `${label} botId`),
    text: channelText(candidate.text, CHANNEL_TEXT_MAX, `${label} text`),
    hop: candidate.hop as number,
    at: channelText(candidate.at, 64, `${label} at`),
    history: candidate.history.map((message, index) =>
      decodeChannelMessageViewV1(message, `${label} history[${index}]`),
    ),
    ...(candidate.external === undefined
      ? {}
      : { external: candidate.external as boolean }),
    ...(candidate.senderBotId === undefined
      ? {}
      : {
          senderBotId: channelText(
            candidate.senderBotId,
            CHANNEL_ID_MAX,
            `${label} senderBotId`,
          ),
        }),
    ...(candidate.senderPeer === undefined
      ? {}
      : {
          senderPeer: channelText(
            candidate.senderPeer,
            CHANNEL_ID_MAX,
            `${label} senderPeer`,
          ),
        }),
  };
}

export function decodeChannelMessageViewV1(
  value: unknown,
  label = "Channel message view",
): ChannelMessageViewV1 {
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
  if (!Array.isArray(candidate.reactions)) {
    throw new ChannelDecodeError(`${label} reactions must be an array`);
  }
  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 0) {
    throw new ChannelDecodeError(`${label} seq is invalid`);
  }
  if (!Number.isSafeInteger(candidate.hop) || (candidate.hop as number) < 1) {
    throw new ChannelDecodeError(`${label} hop is invalid`);
  }
  return {
    schemaVersion: 1,
    messageId: commandIdentifier(candidate.messageId, `${label} messageId`),
    channelId: commandIdentifier(candidate.channelId, `${label} channelId`),
    seq: candidate.seq as number,
    text: channelText(candidate.text, CHANNEL_TEXT_MAX, `${label} text`),
    hop: candidate.hop as number,
    at: channelText(candidate.at, 64, `${label} at`),
    reactions: candidate.reactions.map((reaction) => {
      const entry = channelRecord(reaction, `${label} reaction`);
      channelExactKeys(
        entry,
        ["emoji", "botId", "at"],
        [],
        `${label} reaction`,
      );
      return {
        emoji: channelText(entry.emoji, CHANNEL_EMOJI_MAX, "emoji"),
        botId: channelText(entry.botId, CHANNEL_ID_MAX, "botId"),
        at: channelText(entry.at, 64, "at"),
      };
    }),
    ...(candidate.senderBotId === undefined
      ? {}
      : {
          senderBotId: channelText(
            candidate.senderBotId,
            CHANNEL_ID_MAX,
            `${label} senderBotId`,
          ),
        }),
    ...(candidate.senderPeer === undefined
      ? {}
      : {
          senderPeer: channelText(
            candidate.senderPeer,
            CHANNEL_ID_MAX,
            `${label} senderPeer`,
          ),
        }),
  };
}

/** The Session a Bot's participation in one Channel runs under. */
export function channelSessionIdV1(channelId: string): string {
  return `channel:${channelId}`;
}

/**
 * The run one delivered message is admitted under. It *is* the message id, so
 * a redelivery of the same message is refused by the Bot Durable Object's own
 * Turn idempotency rather than running the Bot twice.
 */
export function channelRunIdV1(messageId: string): string {
  return `ch-${messageId}`;
}

/**
 * One Channel view, decoded on arrival. The User Durable Object and the Bot
 * Durable Object are two authorities behind one RPC seam, so what crosses it is
 * decoded rather than trusted in the shape RPC happened to return.
 */
export function decodeChannelViewV1(
  value: unknown,
  label = "Channel view",
): ChannelViewV1 {
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
      "createdAt",
      "updatedAt",
    ],
    ["connectionId"],
    label,
  );
  const record = decodeChannelRecordV1(
    {
      ...candidate,
      createdBy: { kind: "user" },
    },
    label,
  );
  if (typeof candidate.active !== "boolean") {
    throw new ChannelDecodeError(`${label} active must be a boolean`);
  }
  return {
    ...channelViewV1(record),
    active: candidate.active,
  };
}

export function decodeChannelListViewV1(
  value: unknown,
  label = "Channel list",
): ChannelListViewV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "botId", "channels"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!Array.isArray(candidate.channels)) {
    throw new ChannelDecodeError(`${label} channels must be an array`);
  }
  return {
    schemaVersion: 1,
    botId: commandIdentifier(candidate.botId, `${label} botId`),
    channels: candidate.channels.map((channel, index) =>
      decodeChannelViewV1(channel, `${label} channels[${index}]`),
    ),
  };
}

export function decodeChannelCommandReceiptV1(
  value: unknown,
  label = "Channel receipt",
): ChannelCommandReceiptV1 {
  const candidate = channelRecord(value, label);
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  const commandId = commandIdentifier(
    candidate.commandId,
    `${label} commandId`,
  );
  if (candidate.status === "applied") {
    channelExactKeys(
      candidate,
      ["schemaVersion", "commandId", "status", "channel"],
      [],
      label,
    );
    return {
      schemaVersion: 1,
      commandId,
      status: "applied",
      channel: decodeChannelViewV1(candidate.channel, `${label} channel`),
    };
  }
  if (candidate.status === "posted") {
    channelExactKeys(
      candidate,
      [
        "schemaVersion",
        "commandId",
        "status",
        "channel",
        "message",
        "recipients",
      ],
      [],
      label,
    );
    if (!Array.isArray(candidate.recipients)) {
      throw new ChannelDecodeError(`${label} recipients must be an array`);
    }
    return {
      schemaVersion: 1,
      commandId,
      status: "posted",
      channel: decodeChannelViewV1(candidate.channel, `${label} channel`),
      message: decodeChannelMessageViewV1(
        candidate.message,
        `${label} message`,
      ),
      recipients: candidate.recipients.map((recipient, index) =>
        commandIdentifier(recipient, `${label} recipients[${index}]`),
      ),
    };
  }
  if (candidate.status === "reacted") {
    channelExactKeys(
      candidate,
      [
        "schemaVersion",
        "commandId",
        "status",
        "channelId",
        "messageId",
        "emoji",
        "botId",
        "added",
      ],
      [],
      label,
    );
    if (typeof candidate.added !== "boolean") {
      throw new ChannelDecodeError(`${label} added must be a boolean`);
    }
    return {
      schemaVersion: 1,
      commandId,
      status: "reacted",
      channelId: commandIdentifier(candidate.channelId, `${label} channelId`),
      messageId: commandIdentifier(candidate.messageId, `${label} messageId`),
      emoji: channelText(candidate.emoji, CHANNEL_EMOJI_MAX, `${label} emoji`),
      botId: commandIdentifier(candidate.botId, `${label} botId`),
      added: candidate.added,
    };
  }
  if (candidate.status !== "refused") {
    throw new ChannelDecodeError(`${label} status is unknown`);
  }
  channelExactKeys(
    candidate,
    ["schemaVersion", "commandId", "status", "refusal", "reason"],
    [],
    label,
  );
  const refusal = CHANNEL_REFUSALS.find((known) => known === candidate.refusal);
  if (!refusal) {
    throw new ChannelDecodeError(`${label} refusal is unknown`);
  }
  return {
    schemaVersion: 1,
    commandId,
    status: "refused",
    refusal,
    reason: channelText(candidate.reason, CHANNEL_TEXT_MAX, `${label} reason`),
  };
}

export function decodeChannelThreadPageViewV1(
  value: unknown,
  label = "Channel thread page",
): ChannelThreadPageViewV1 {
  const candidate = channelRecord(value, label);
  channelExactKeys(
    candidate,
    ["schemaVersion", "channel", "messages"],
    ["connectionLabel", "platform"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ChannelDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!Array.isArray(candidate.messages)) {
    throw new ChannelDecodeError(`${label} messages must be an array`);
  }
  return {
    schemaVersion: 1,
    channel: decodeChannelViewV1(candidate.channel, `${label} channel`),
    messages: candidate.messages.map((message, index) =>
      decodeChannelMessageViewV1(message, `${label} messages[${index}]`),
    ),
    ...(candidate.connectionLabel === undefined
      ? {}
      : {
          connectionLabel: channelText(
            candidate.connectionLabel,
            CHANNEL_NAME_MAX,
            `${label} connectionLabel`,
          ),
        }),
    ...(candidate.platform === undefined
      ? {}
      : {
          platform: channelText(
            candidate.platform,
            CHANNEL_ID_MAX,
            `${label} platform`,
          ),
        }),
  };
}
