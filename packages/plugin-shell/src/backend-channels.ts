// The Bot Durable Object's half of the Channels seam.
//
// The authority is split, deliberately. The Channel record, its membership and
// its canonical message log are User-scoped and live in the User Durable
// Object; only the Bot Durable Object admits the Bot's own `channel` Turn. This
// module is the join: it queues a delivered message durably, turns it into the
// Turn command the kernel admits, and renders the Channel's own log as that
// Turn's model history.
//
// DELIVERY IS A DURABLE QUEUE. `deliverChannelInput` writes the input down and
// returns; nothing runs inside the RPC that delivered it. The Turn is admitted
// when the object's one active run frees — on the same alarm the Bot already
// has — so a Bot that is mid-Turn takes the message and answers it afterwards
// rather than refusing it or running two Turns at once.
//
// REDELIVERY IS FREE. The run id is derived from the message id and the origin
// names the message, so the kernel's own Turn idempotency refuses a second
// admission of the same message. The User Durable Object may retry its fan-out
// as often as it likes.
import {
  channelSessionIdV1,
  decodeChannelInputV1,
  type ChannelInputV1,
  type ChannelMessageViewV1,
} from "@frockbot/plugin-channels/shared";
import { CHANNEL_HISTORY_LIMIT } from "@frockbot/plugin-channels/records";
import type {
  BotDirectoryEntryV1,
  ChannelsRuntimeHostV1,
} from "@frockbot/plugin-channels/agent-host";
import type {
  ChannelCommandReceiptV1,
  ChannelCommandV1,
  ChannelListViewV1,
} from "@frockbot/plugin-channels/shared";
import type { ChannelWriterV1 } from "@frockbot/plugin-channels/records";
import type {
  LlmMessage,
  SessionEvent,
  TurnTypeV1,
} from "@frockbot/kernel-contracts";

/** One queued Channel input, in this Bot's own Durable Object storage. */
export const CHANNEL_PENDING_PREFIX = "channel-pending:";

export function channelPendingKeyV1(messageId: string): string {
  return `${CHANNEL_PENDING_PREFIX}${messageId}`;
}

/**
 * The run one delivered message is admitted under.
 *
 * Derived from the message id and from nothing else, so the same message
 * delivered twice is one run. The prefix keeps a Channel run distinguishable
 * from a chat run in the run index without having to read the record.
 */
export function channelRunIdV1(messageId: string): string {
  return `ch-${messageId}`;
}

export interface BotChannelsIdentity {
  userId: string;
  botId: string;
}

/**
 * The Turn command one delivered Channel message is admitted as.
 *
 * `turnType: "channel"` is the ceiling the Turn runs under — `send_to_user` and
 * `wake_parent` are both absent from it, and the three Channel tools are
 * present — and `origin` names the Channel and the message, so the run stays
 * attributable after the Channel's bounded log has trimmed the message away.
 * The Session is the Channel's own, never the User's visible conversation.
 */
export function channelTurnCommandV1(
  identity: BotChannelsIdentity,
  input: ChannelInputV1,
  acceptedAt: string,
) {
  return {
    userId: identity.userId,
    botId: identity.botId,
    runId: channelRunIdV1(input.messageId),
    sessionId: channelSessionIdV1(input.channelId),
    acceptedAt,
    text: channelTurnTextV1(input),
    turnType: "channel" as const,
    origin: {
      kind: "channel" as const,
      channelId: input.channelId,
      fireId: input.messageId,
      trigger: "integration" as const,
    },
  };
}

/** The sender of one message, as the thread names it. */
function senderLabelV1(message: {
  senderBotId?: string;
  senderPeer?: string;
}): string {
  return message.senderBotId ?? message.senderPeer ?? "someone";
}

/**
 * What the Turn is actually run on: the message that woke it, framed by the
 * room it was said in. The message's own text is kept verbatim and on its own
 * lines, because it is what a teammate wrote and not something to paraphrase.
 */
export function channelTurnTextV1(input: ChannelInputV1): string {
  return [
    `You are in channel "${input.channelName}" (${input.channelId}).`,
    `${senderLabelV1(input)} posted:`,
    input.text,
  ].join("\n");
}

/**
 * The Channel's own recent messages, as the Turn's model history.
 *
 * A `channel` Turn does **not** replay the Bot's personal transcript: it is not
 * in the conversation with its User, and copying that conversation into a room
 * with other Bots in it would be a leak as much as a distraction. What it gets
 * instead is the thread it is actually in — which is the fresh-history mode the
 * Agent runtime applies, and which is never written to the Bot's durable log.
 *
 * The message that woke the Turn is excluded: it is the Turn's own input, and
 * would otherwise be said twice.
 */
export function channelTurnHistoryV1(input: {
  history: readonly ChannelMessageViewV1[];
  messageId: string;
  selfBotId: string;
}): LlmMessage[] {
  const prior = input.history
    .filter((message) => message.messageId !== input.messageId)
    .slice(-CHANNEL_HISTORY_LIMIT);
  return prior.map((message) =>
    message.senderBotId === input.selfBotId
      ? { role: "assistant", content: message.text, toolCalls: [] }
      : {
          role: "user",
          content: `${senderLabelV1(message)}: ${message.text}`,
        },
  );
}

/**
 * What one settled `channel` Turn said out loud.
 *
 * A Bot in an external Channel speaks with `send_to_user`, exactly as it does
 * to its own User — there is no second tool and no key in the Turn. The
 * connector observes what was *recorded*, so what reaches the platform is
 * whatever the durable log says the Bot said, in the order it said it, and a
 * Turn that failed after speaking still has its sends carried.
 *
 * Only `text` payloads travel. A widget, an approval or an attachment is a
 * WebUI affordance with no meaning on a remote platform, and a connector that
 * silently flattened one into prose would be inventing a message.
 */
export function channelOutboundSendsV1(
  events: readonly SessionEvent[],
): string[] {
  const sends: string[] = [];
  for (const event of events) {
    if (event.type !== "send/to-user") continue;
    if (event.payload.type !== "text") continue;
    const text = event.payload.text.trim();
    if (text.length > 0) sends.push(text);
  }
  return sends;
}

/**
 * The Channel a settled run belongs to, or `undefined` when it is an ordinary
 * Turn. Read off the durable admission record, so it survives an eviction.
 */
export function settledChannelOriginV1(run: {
  admission?: {
    turnType?: string;
    origin?: { kind: string; channelId?: string; fireId?: string };
  };
}): { channelId: string; messageId: string } | undefined {
  if (run.admission?.turnType !== "channel") return undefined;
  const origin = run.admission.origin;
  if (!origin || origin.kind !== "channel") return undefined;
  if (!origin.channelId || !origin.fireId) return undefined;
  return { channelId: origin.channelId, messageId: origin.fireId };
}

/** The User Durable Object RPC the Channels seam needs, narrowed to it. */
export interface BotChannelsRpcV1 {
  execute(
    command: ChannelCommandV1,
    writer: ChannelWriterV1,
  ): Promise<ChannelCommandReceiptV1>;
  list(botId: string): Promise<ChannelListViewV1>;
  directory(): Promise<BotDirectoryEntryV1[]>;
}

/**
 * The Channels seam one admitted Turn runs under. A Turn is required: a Bot
 * posts to a Channel only inside a Turn whose Session and Turn its provenance
 * can name, exactly as it writes a Routine or a Skill.
 */
export function createBotChannelsHost(
  identity: BotChannelsIdentity,
  turn: { runId: string; turnId: string; sessionId: string },
  rpc: BotChannelsRpcV1,
  context: {
    turnType?: TurnTypeV1;
    origin?: { channelId: string; hop: number };
  } = {},
): ChannelsRuntimeHostV1 {
  return {
    botId: identity.botId,
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    ...(context.turnType ? { turnType: context.turnType } : {}),
    ...(context.origin ? { origin: context.origin } : {}),
    list: () => rpc.list(identity.botId),
    directory: () => rpc.directory(),
    execute: (command, writer) => rpc.execute(command, writer),
  };
}

export { decodeChannelInputV1 };
export type { ChannelInputV1 };
