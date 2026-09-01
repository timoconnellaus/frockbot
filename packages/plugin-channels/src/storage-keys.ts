// The User Durable Object storage keys the Channels Package owns.
//
// "The User's Durable Object is the authority for everything User-scoped." A
// Channel spans the Bots of one User, so its record, its membership, its
// message log and its rate bucket are User-scoped and live here. The keys are
// declared in the Package rather than in the kernel, because the kernel imports
// no Package and holds no product policy: the Durable Object hands this Package
// a storage seam and this module decides what it writes under.
//
// Each Bot's *participation* is not here. That is a `channel` Turn in the Bot's
// own Durable Object event log, and the Bot Durable Object is its only author.

/** One `ChannelRecordV1`. */
export const CHANNEL_PREFIX = "channel:";
/** One `ChannelMessageV1`, keyed so a prefix listing is in `seq` order. */
export const CHANNEL_MESSAGE_PREFIX = "channel-message:";
/** One Channel's next `seq`. */
export const CHANNEL_SEQUENCE_PREFIX = "channel-seq:";
/** One `ChannelDeliveryV1`: one recipient's debt for one message. */
export const CHANNEL_DELIVERY_PREFIX = "channel-delivery:";
/** One durable command receipt, keyed by the command's idempotency key. */
export const CHANNEL_RECEIPT_PREFIX = "channel-receipt:";
/** One Channel's durable token bucket. */
export const CHANNEL_BUCKET_PREFIX = "channel-bucket:";
/**
 * One external Channel's webhook key, as a digest. Never the token: the token
 * is derived from the deployment secret and the claims, and what is kept here
 * is only enough to recognise it again. `disconnect` deletes this key, which is
 * what revocation *is*.
 */
export const CHANNEL_TOKEN_PREFIX = "channel-token:";

/** Sequence keys are zero-padded so a lexical listing is a numeric one. */
const SEQUENCE_WIDTH = 12;

export function channelKeyV1(channelId: string): string {
  return `${CHANNEL_PREFIX}${channelId}`;
}

export function channelMessagePrefixV1(channelId: string): string {
  return `${CHANNEL_MESSAGE_PREFIX}${channelId}:`;
}

export function channelMessageKeyV1(channelId: string, seq: number): string {
  return `${channelMessagePrefixV1(channelId)}${String(seq).padStart(
    SEQUENCE_WIDTH,
    "0",
  )}`;
}

export function channelSequenceKeyV1(channelId: string): string {
  return `${CHANNEL_SEQUENCE_PREFIX}${channelId}`;
}

export function channelDeliveryPrefixV1(messageId: string): string {
  return `${CHANNEL_DELIVERY_PREFIX}${messageId}:`;
}

export function channelDeliveryKeyV1(messageId: string, botId: string): string {
  return `${channelDeliveryPrefixV1(messageId)}${botId}`;
}

export function channelReceiptKeyV1(commandId: string): string {
  return `${CHANNEL_RECEIPT_PREFIX}${commandId}`;
}

export function channelBucketKeyV1(channelId: string): string {
  return `${CHANNEL_BUCKET_PREFIX}${channelId}`;
}

export function channelTokenStorageKeyV1(channelId: string): string {
  return `${CHANNEL_TOKEN_PREFIX}${channelId}`;
}

/** The next `seq` a Channel owes, read off its cursor record. */
export function channelSequenceCursorV1(value: unknown): { nextSeq: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { nextSeq: 0 };
  }
  const candidate = value as { nextSeq?: unknown };
  return Number.isSafeInteger(candidate.nextSeq) &&
    (candidate.nextSeq as number) >= 0
    ? { nextSeq: candidate.nextSeq as number }
    : { nextSeq: 0 };
}
