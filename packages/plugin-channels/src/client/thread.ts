// The Channel thread, as a projection.
//
// Nothing here reads storage, holds a reference or talks to a transport: it
// takes the `ChannelMessageViewV1` list the backend already decided on and
// folds it into what a person looks at. "The hosted client renders backend
// state and submits commands. It does not become an alternate authority" — so
// `seq`, the reactions and the membership are read, never recomputed, and the
// only thing invented here is presentation: which bubbles belong together, how
// the same emoji from three Bots reads as one chip, and where the unread rule
// puts its divider.
import type { ChannelMessageViewV1 } from "../shared.js";

/** One tapback, folded across every sender that left it. */
export interface ChannelReactionChipV1 {
  emoji: string;
  count: number;
  /** Who reacted, in the order the log recorded them. */
  botIds: string[];
  /** Whether the Bot whose view this is has already left this tapback. */
  mine: boolean;
}

/** One message, ready to render. */
export interface ChannelThreadMessageV1 {
  messageId: string;
  seq: number;
  text: string;
  at: string;
  /** The sender's Bot id, when a Bot said it. */
  senderBotId?: string;
  /** The remote peer, when a connector delivered it. */
  senderPeer?: string;
  /** True when this is the Bot whose sidebar row opened the thread. */
  mine: boolean;
  reactions: ChannelReactionChipV1[];
}

/**
 * Consecutive messages from one sender, drawn under one avatar.
 *
 * Grouping is by sender *and* by adjacency: a reply in between breaks the run,
 * because the room's order is the only thing the thread is allowed to convey
 * and merging across it would say the conversation happened differently.
 */
export interface ChannelThreadGroupV1 {
  /** Stable across a re-render: the first message's id names the group. */
  groupId: string;
  senderBotId?: string;
  senderPeer?: string;
  mine: boolean;
  messages: ChannelThreadMessageV1[];
  /** True when the unread divider is drawn above this group. */
  firstUnread: boolean;
}

/** The sender of one message, as the thread names it. */
export function channelSenderKeyV1(message: {
  senderBotId?: string;
  senderPeer?: string;
}): string {
  if (message.senderBotId !== undefined) return `bot:${message.senderBotId}`;
  if (message.senderPeer !== undefined) return `peer:${message.senderPeer}`;
  return "unknown";
}

/**
 * Fold every reaction on one message into one chip per emoji.
 *
 * The log records a reaction per `(messageId, botId, emoji)`, which is what
 * makes `react_to_message` idempotent; a person wants to see "👍 3", so the
 * count is the fold and the senders come with it for the tooltip.
 */
export function foldChannelReactionsV1(
  reactions: readonly { emoji: string; botId: string }[],
  selfBotId?: string,
): ChannelReactionChipV1[] {
  const chips = new Map<string, ChannelReactionChipV1>();
  for (const reaction of reactions) {
    const chip = chips.get(reaction.emoji);
    if (!chip) {
      chips.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        botIds: [reaction.botId],
        mine: reaction.botId === selfBotId,
      });
      continue;
    }
    // The same Bot reacting twice with the same emoji is not two tapbacks; the
    // store already refuses it, and folding defensively keeps a replayed log
    // from rendering one.
    if (chip.botIds.includes(reaction.botId)) continue;
    chip.botIds.push(reaction.botId);
    chip.count += 1;
    if (reaction.botId === selfBotId) chip.mine = true;
  }
  return [...chips.values()];
}

/**
 * The thread a Channel surface renders.
 *
 * `selfBotId` is the member whose row opened the Channel — it decides which
 * bubbles are drawn as this Bot's own and which tapbacks are already theirs.
 * `lastReadSeq` is the durable read position: the divider sits above the first
 * message strictly above it, and no divider is drawn when nothing is unread.
 */
export function projectChannelThreadV1(
  messages: readonly ChannelMessageViewV1[],
  options: { selfBotId?: string; lastReadSeq?: number } = {},
): ChannelThreadGroupV1[] {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  const firstUnread = ordered.find(
    (message) =>
      options.lastReadSeq !== undefined && message.seq > options.lastReadSeq,
  );
  const groups: ChannelThreadGroupV1[] = [];
  for (const message of ordered) {
    const projected: ChannelThreadMessageV1 = {
      messageId: message.messageId,
      seq: message.seq,
      text: message.text,
      at: message.at,
      mine:
        options.selfBotId !== undefined &&
        message.senderBotId === options.selfBotId,
      reactions: foldChannelReactionsV1(message.reactions, options.selfBotId),
      ...(message.senderBotId === undefined
        ? {}
        : { senderBotId: message.senderBotId }),
      ...(message.senderPeer === undefined
        ? {}
        : { senderPeer: message.senderPeer }),
    };
    const open = groups.at(-1);
    const continues =
      open !== undefined &&
      channelSenderKeyV1(open) === channelSenderKeyV1(projected) &&
      // A group cannot straddle the divider: the line has to fall between two
      // bubbles, not through the middle of one sender's run.
      !(
        firstUnread !== undefined && message.messageId === firstUnread.messageId
      );
    if (continues) {
      open.messages.push(projected);
      continue;
    }
    groups.push({
      groupId: projected.messageId,
      mine: projected.mine,
      messages: [projected],
      firstUnread:
        firstUnread !== undefined &&
        firstUnread.messageId === projected.messageId,
      ...(projected.senderBotId === undefined
        ? {}
        : { senderBotId: projected.senderBotId }),
      ...(projected.senderPeer === undefined
        ? {}
        : { senderPeer: projected.senderPeer }),
    });
  }
  return groups;
}

/**
 * Everyone in the room, in membership order, with the sender of the newest
 * message first-class enough to be named even when they are not a member.
 *
 * An external Channel's peer is not a member — the record says so — but a
 * members strip that omitted the person on the other end would be describing
 * the room wrongly.
 */
export function projectChannelMembersV1(
  members: readonly string[],
  messages: readonly ChannelMessageViewV1[],
): { botId?: string; peer?: string }[] {
  const strip: { botId?: string; peer?: string }[] = members.map((botId) => ({
    botId,
  }));
  const peers = new Set<string>();
  for (const message of messages) {
    if (message.senderPeer === undefined) continue;
    if (peers.has(message.senderPeer)) continue;
    peers.add(message.senderPeer);
    strip.push({ peer: message.senderPeer });
  }
  return strip;
}
