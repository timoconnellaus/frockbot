// The Channels authority: the User Durable Object's durable Channel records.
//
// "The User's Durable Object is the authority for everything User-scoped." A
// group Channel spans several of one User's Bots, so its record, its
// membership, its canonical message log and its rate bucket are User-scoped and
// live here. Each Bot's *participation* is a `channel` Turn in that Bot's own
// Durable Object, which this class never writes and never could.
//
// Two rules are enforced here and nowhere else:
//
//  * One command id applies once. The receipt is durable and fingerprinted, so
//    a retried command replays its recorded outcome and a reused key carrying
//    different bytes is an error rather than a silent second write.
//
//  * A message and every delivery it owes become durable together. `post`
//    appends the message with the `seq` this transaction assigns *and* writes
//    one `ChannelDeliveryV1` per recipient in the same transaction. Fan-out is
//    a second, retryable step that can be repeated freely, because the debt it
//    is discharging is already written down.
//
// Three bounds refuse rather than throw: `hop`, the per-Channel token bucket,
// and membership. A refusal is a recorded receipt — the constitution wants a
// failure that can be read back, not one raised into a caller that may or may
// not write it down.
import {
  CHANNEL_HOP_MAX,
  CHANNEL_LIMIT_PER_USER,
  CHANNEL_MEMBER_MAX,
  CHANNEL_MEMBER_MIN,
  CHANNEL_MESSAGE_LOG_LIMIT,
  CHANNEL_RATE_LIMIT,
  CHANNEL_RATE_WINDOW_MS,
  CHANNEL_REACTION_LIMIT,
  ChannelDecodeError,
  decodeChannelDeliveryV1,
  decodeChannelMessageV1,
  decodeChannelRecordV1,
  isChannelIdV1,
  type ChannelDeliveryV1,
  type ChannelMessageV1,
  type ChannelRecordV1,
  type ChannelWriterV1,
} from "./records.js";
import {
  channelBucketKeyV1,
  channelDeliveryKeyV1,
  channelDeliveryPrefixV1,
  channelKeyV1,
  channelMessageKeyV1,
  channelMessagePrefixV1,
  channelReadKeyV1,
  channelReadReceiptKeyV1,
  channelReceiptKeyV1,
  channelSequenceCursorV1,
  channelSequenceKeyV1,
  channelTokenStorageKeyV1,
  CHANNEL_PREFIX,
} from "./storage-keys.js";
import {
  channelConstantTimeEqualsV1,
  decodeChannelTokenKeyV1,
  type ChannelTokenKeyV1,
} from "./token.js";
import {
  advanceChannelReadCursorV1,
  channelReadCommandFingerprintV1,
  decodeChannelReadCursorV1,
  projectChannelUnreadViewV1,
  CHANNEL_UNREAD_FANOUT_LIMIT,
  CHANNEL_UNREAD_PENDING_SCAN,
  type ChannelReadCommandV1,
  type ChannelReadCursorV1,
  type ChannelUnreadDirectoryViewV1,
  type ChannelUnreadViewV1,
} from "./unread.js";
import {
  channelCommandFingerprintV1,
  channelMessageViewV1,
  channelViewV1,
  type ChannelCommandReceiptV1,
  type ChannelCommandV1,
  type ChannelListViewV1,
  type ChannelMessageViewV1,
  type ChannelRefusalV1,
  type ChannelThreadViewV1,
} from "./shared.js";

/** The reads a Channel listing needs. */
export interface ChannelStorageReadsV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

/** The writes one transaction performs. */
export interface ChannelStorageWritesV1 extends ChannelStorageReadsV1 {
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The Durable Object storage seam. `DurableObjectStorage` satisfies it. */
export interface ChannelStorageV1 extends ChannelStorageWritesV1 {
  transaction<T>(
    closure: (transaction: ChannelStorageWritesV1) => Promise<T>,
  ): Promise<T>;
}

interface StoredChannelReceiptV1 {
  commandFingerprint: string;
  receipt: ChannelCommandReceiptV1;
}

/** One Channel's durable token bucket. */
interface ChannelBucketV1 {
  schemaVersion: 1;
  windowStartedAt: number;
  count: number;
}

export interface ChannelStoreOptionsV1 {
  /** Injected so a test can pin a clock; production passes nothing. */
  now?(): Date;
  /** Injected so a test can pin an id; production passes nothing. */
  newChannelId?(): string;
}

function refusal(
  commandId: string,
  refusalKind: ChannelRefusalV1,
  reason: string,
): ChannelCommandReceiptV1 {
  return {
    schemaVersion: 1,
    commandId,
    status: "refused",
    refusal: refusalKind,
    reason,
  };
}

export class ChannelStore {
  readonly #storage: ChannelStorageV1;
  readonly #now: () => Date;
  readonly #newChannelId: () => string;

  constructor(storage: ChannelStorageV1, options: ChannelStoreOptionsV1 = {}) {
    this.#storage = storage;
    this.#now = options.now ?? (() => new Date());
    this.#newChannelId = options.newChannelId ?? (() => crypto.randomUUID());
  }

  /** Every Channel one Bot is a member of, newest first. */
  async list(botId: string): Promise<ChannelListViewV1> {
    const stored = await this.#storage.list<unknown>({
      prefix: CHANNEL_PREFIX,
      limit: CHANNEL_LIMIT_PER_USER,
    });
    const channels = [...stored.values()]
      .map((value) => decodeChannelRecordV1(value))
      .filter((record) => record.members.includes(botId))
      .map((record) => channelViewV1(record));
    channels.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    return { schemaVersion: 1, botId, channels };
  }

  async read(channelId: string): Promise<ChannelRecordV1 | undefined> {
    if (!isChannelIdV1(channelId)) {
      throw new ChannelDecodeError("Channel id is invalid");
    }
    const stored = await this.#storage.get<unknown>(channelKeyV1(channelId));
    return stored === undefined ? undefined : decodeChannelRecordV1(stored);
  }

  /**
   * One Channel's recent messages, oldest last-first order preserved.
   *
   * This is the whole of a `channel` Turn's model history: the Turn replays no
   * personal transcript, and the Channel's own log is the thread it is in.
   */
  async thread(
    channelId: string,
    limit = CHANNEL_MESSAGE_LOG_LIMIT,
  ): Promise<ChannelThreadViewV1> {
    const stored = await this.#storage.list<unknown>({
      prefix: channelMessagePrefixV1(channelId),
      limit: CHANNEL_MESSAGE_LOG_LIMIT,
    });
    const messages = [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => channelMessageViewV1(decodeChannelMessageV1(value)));
    return {
      schemaVersion: 1,
      channelId,
      messages: messages.slice(-limit),
    };
  }

  /**
   * Record one external Channel's webhook key.
   *
   * A digest, never the token. Writing it is what makes a minted token usable;
   * deleting it is what revocation is, and both are single durable facts so a
   * connect that fails halfway leaves either a Channel with no key — which
   * takes no delivery — or a key with no Channel, which resolves to nothing.
   */
  async putTokenKey(record: ChannelTokenKeyV1): Promise<void> {
    await this.#storage.put(
      channelTokenStorageKeyV1(record.channelId),
      decodeChannelTokenKeyV1(record),
    );
  }

  async readTokenKey(
    channelId: string,
  ): Promise<ChannelTokenKeyV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      channelTokenStorageKeyV1(channelId),
    );
    return stored === undefined ? undefined : decodeChannelTokenKeyV1(stored);
  }

  /** Revoke one Channel's webhook key. Idempotent. */
  async revokeTokenKey(channelId: string): Promise<void> {
    await this.#storage.delete(channelTokenStorageKeyV1(channelId));
  }

  /**
   * Whether a presented token is still this Channel's key.
   *
   * The edge proved the token was minted by this deployment; this proves the
   * Channel has not since revoked or rotated it. The comparison is
   * constant-time for the same reason the signature check is.
   */
  async holdsTokenDigest(
    channelId: string,
    digest: string,
    keyVersion: number,
  ): Promise<boolean> {
    const key = await this.readTokenKey(channelId);
    if (!key) return false;
    return (
      key.keyVersion === keyVersion &&
      channelConstantTimeEqualsV1(key.digest, digest)
    );
  }

  /**
   * How far the User has read one Channel, or nothing when they never have.
   *
   * User-scoped, like everything else about a Channel: the Bot Durable Object
   * derives its own badge from its own admission index and holds no opinion
   * about a room it is only a member of.
   */
  async readCursor(
    channelId: string,
  ): Promise<ChannelReadCursorV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      channelReadKeyV1(channelId),
    );
    return stored === undefined ? undefined : decodeChannelReadCursorV1(stored);
  }

  /**
   * Record that the User read one Channel up to a `seq`.
   *
   * Monotonic, and durably receipted like every other command here: a retried
   * command replays its recorded outcome, a reused id carrying different bytes
   * is an error, and a cursor that is not newer leaves the record untouched.
   */
  async markRead(
    command: ChannelReadCommandV1,
  ): Promise<ChannelReadCursorV1 | undefined> {
    const fingerprint = channelReadCommandFingerprintV1(command);
    const receiptKey = channelReadReceiptKeyV1(command.commandId);
    const cursorKey = channelReadKeyV1(command.channelId);
    return this.#storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(receiptKey);
      if (stored !== undefined) {
        const receipt = stored as {
          commandFingerprint?: unknown;
          cursor?: unknown;
        };
        if (receipt.commandFingerprint !== fingerprint) {
          throw new ChannelDecodeError(
            "Channel read commandId was reused for a different command",
          );
        }
        return receipt.cursor === undefined
          ? undefined
          : decodeChannelReadCursorV1(receipt.cursor);
      }
      const current = await transaction.get<unknown>(cursorKey);
      const next = advanceChannelReadCursorV1(
        current === undefined ? undefined : decodeChannelReadCursorV1(current),
        {
          channelId: command.channelId,
          upToSeq: command.upToSeq,
          at: this.#now().toISOString(),
        },
      );
      await transaction.put(cursorKey, next);
      await transaction.put(receiptKey, {
        commandFingerprint: fingerprint,
        cursor: next,
      });
      return next;
    });
  }

  /**
   * Unread for every Channel one Bot is a member of.
   *
   * Two bounds keep one poll's cost proportional to what a person could be
   * behind on: the fan-out answers for at most
   * {@link CHANNEL_UNREAD_FANOUT_LIMIT} Channels, and the "a delivery is still
   * pending" clause looks only at each Channel's newest
   * {@link CHANNEL_UNREAD_PENDING_SCAN} messages. Neither bound changes what
   * an ordinary room reports; both stop a pathological one from costing the
   * whole log on every tick.
   */
  async unread(botId: string): Promise<ChannelUnreadDirectoryViewV1> {
    const listed = await this.list(botId);
    const unread: ChannelUnreadViewV1[] = [];
    for (const channel of listed.channels.slice(
      0,
      CHANNEL_UNREAD_FANOUT_LIMIT,
    )) {
      unread.push(await this.channelUnread(channel.channelId));
    }
    return { schemaVersion: 1, botId, unread };
  }

  /** One Channel's row, under the same two bounds {@link unread} pays. */
  async channelUnread(channelId: string): Promise<ChannelUnreadViewV1> {
    const thread = await this.thread(channelId);
    const cursor = await this.readCursor(channelId);
    const pendingMessageIds: string[] = [];
    for (const message of thread.messages.slice(-CHANNEL_UNREAD_PENDING_SCAN)) {
      const deliveries = await this.deliveries(message.messageId);
      if (deliveries.some((delivery) => delivery.state === "pending")) {
        pendingMessageIds.push(message.messageId);
      }
    }
    return projectChannelUnreadViewV1(channelId, {
      messages: thread.messages,
      pendingMessageIds,
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  /** Every delivery one message owes, in member order. */
  async deliveries(messageId: string): Promise<ChannelDeliveryV1[]> {
    const stored = await this.#storage.list<unknown>({
      prefix: channelDeliveryPrefixV1(messageId),
    });
    return [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => decodeChannelDeliveryV1(value));
  }

  /**
   * Record that a recipient admitted its own `channel` Turn for one message.
   *
   * Idempotent and monotonic: a delivery already `admitted` keeps the run it
   * first named, so a retried fan-out cannot rewrite history.
   */
  async markAdmitted(
    messageId: string,
    botId: string,
    runId: string,
  ): Promise<void> {
    const key = channelDeliveryKeyV1(messageId, botId);
    await this.#storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) return;
      const delivery = decodeChannelDeliveryV1(stored);
      if (delivery.state === "admitted") return;
      await transaction.put(key, {
        ...delivery,
        state: "admitted",
        runId,
      } satisfies ChannelDeliveryV1);
    });
  }

  /**
   * Apply one command. The receipt is durable and fingerprinted, so a retry of
   * the same command id replays its outcome and a reused id carrying different
   * bytes is refused.
   *
   * A refusal is returned rather than thrown, and it is stored: the hop, quota
   * and membership bounds are product answers, and a caller retrying the same
   * command must be told the same answer.
   */
  async execute(
    command: ChannelCommandV1,
    writer: ChannelWriterV1,
  ): Promise<ChannelCommandReceiptV1> {
    const fingerprint = channelCommandFingerprintV1(command);
    const outcome = await this.#storage.transaction<
      | { ok: true; receipt: ChannelCommandReceiptV1 }
      | { ok: false; error: unknown }
    >(async (transaction) => {
      const receiptKey = channelReceiptKeyV1(command.commandId);
      const existing =
        await transaction.get<StoredChannelReceiptV1>(receiptKey);
      if (existing) {
        if (existing.commandFingerprint !== fingerprint) {
          return {
            ok: false,
            error: new ChannelDecodeError(
              `Channel command idempotency key "${command.commandId}" was reused for a different command`,
            ),
          };
        }
        return { ok: true, receipt: existing.receipt };
      }
      let receipt: ChannelCommandReceiptV1;
      try {
        receipt = await this.#apply(transaction, command, writer);
      } catch (error) {
        return { ok: false, error };
      }
      await transaction.put(receiptKey, {
        commandFingerprint: fingerprint,
        receipt,
      } satisfies StoredChannelReceiptV1);
      return { ok: true, receipt };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.receipt;
  }

  async #apply(
    transaction: ChannelStorageWritesV1,
    command: ChannelCommandV1,
    writer: ChannelWriterV1,
  ): Promise<ChannelCommandReceiptV1> {
    const at = this.#now().toISOString();
    if (command.type === "channel/create") {
      return this.#create(transaction, command, writer, at);
    }
    const stored = await transaction.get<unknown>(
      channelKeyV1(command.channelId),
    );
    if (stored === undefined) {
      return refusal(
        command.commandId,
        "unknown-channel",
        `Channel "${command.channelId}" is unknown`,
      );
    }
    const current = decodeChannelRecordV1(stored);
    // Row 35: an update is admitted "only if the caller is a member". The same
    // rule governs posting and reacting: a Channel is closed, and being outside
    // it is the whole point of being outside it.
    if (!current.members.includes(command.botId)) {
      return refusal(
        command.commandId,
        "not-a-member",
        `Bot "${command.botId}" is not a member of Channel "${current.channelId}"`,
      );
    }
    if (command.type === "channel/update") {
      return this.#update(transaction, command, current, at);
    }
    if (command.type === "channel/disconnect") {
      const next: ChannelRecordV1 = {
        ...current,
        active: false,
        revision: current.revision + 1,
        updatedAt: at,
      };
      await transaction.put(channelKeyV1(next.channelId), next);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        channel: channelViewV1(next),
      };
    }
    if (!current.active) {
      return refusal(
        command.commandId,
        "inactive",
        `Channel "${current.channelId}" is disconnected and takes no messages`,
      );
    }
    if (command.type === "channel/react") {
      return this.#react(transaction, command, current, at);
    }
    return this.#post(transaction, command, current, at);
  }

  async #create(
    transaction: ChannelStorageWritesV1,
    command: Extract<ChannelCommandV1, { type: "channel/create" }>,
    writer: ChannelWriterV1,
    at: string,
  ): Promise<ChannelCommandReceiptV1> {
    const held = await transaction.list<unknown>({
      prefix: CHANNEL_PREFIX,
      limit: CHANNEL_LIMIT_PER_USER + 1,
    });
    if (held.size >= CHANNEL_LIMIT_PER_USER) {
      throw new ChannelDecodeError(
        `a User may hold at most ${CHANNEL_LIMIT_PER_USER} Channels`,
      );
    }
    const channelId = command.channelId ?? this.#newChannelId();
    if (!isChannelIdV1(channelId)) {
      throw new ChannelDecodeError("Channel id is invalid");
    }
    const existing = await transaction.get<unknown>(channelKeyV1(channelId));
    if (existing !== undefined) {
      // Creating a Channel that is already there is not an error: an implicit
      // pair Channel has a derived id, and two Bots addressing each other for
      // the first time both "create" it. The record that is there wins.
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        channel: channelViewV1(decodeChannelRecordV1(existing)),
      };
    }
    const record = decodeChannelRecordV1({
      schemaVersion: 1,
      channelId,
      kind: command.kind ?? "group",
      name: command.name,
      ...(command.connectionId === undefined
        ? {}
        : { connectionId: command.connectionId }),
      members: command.members,
      revision: 1,
      active: true,
      createdBy: writer,
      createdAt: at,
      updatedAt: at,
    } satisfies ChannelRecordV1);
    await transaction.put(channelKeyV1(channelId), record);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      channel: channelViewV1(record),
    };
  }

  async #update(
    transaction: ChannelStorageWritesV1,
    command: Extract<ChannelCommandV1, { type: "channel/update" }>,
    current: ChannelRecordV1,
    at: string,
  ): Promise<ChannelCommandReceiptV1> {
    const removed = new Set(command.removeMemberIds ?? []);
    const members = current.members.filter((member) => !removed.has(member));
    for (const member of command.addMemberIds ?? []) {
      if (!members.includes(member)) members.push(member);
    }
    if (members.length < CHANNEL_MEMBER_MIN) {
      return refusal(
        command.commandId,
        "membership",
        "a Channel cannot be emptied",
      );
    }
    if (members.length > CHANNEL_MEMBER_MAX) {
      return refusal(
        command.commandId,
        "membership",
        `a Channel holds at most ${CHANNEL_MEMBER_MAX} Bots`,
      );
    }
    const next = decodeChannelRecordV1({
      ...current,
      members,
      revision: current.revision + 1,
      updatedAt: at,
      ...(command.name === undefined ? {} : { name: command.name }),
    } satisfies ChannelRecordV1);
    await transaction.put(channelKeyV1(next.channelId), next);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      channel: channelViewV1(next),
    };
  }

  async #react(
    transaction: ChannelStorageWritesV1,
    command: Extract<ChannelCommandV1, { type: "channel/react" }>,
    current: ChannelRecordV1,
    at: string,
  ): Promise<ChannelCommandReceiptV1> {
    const found = await this.#findMessage(
      transaction,
      current.channelId,
      command.messageId,
    );
    if (!found) {
      return refusal(
        command.commandId,
        "unknown-message",
        `message "${command.messageId}" is not in Channel "${current.channelId}"`,
      );
    }
    // Idempotent on `(messageId, botId, emoji)`: the same tapback twice is one
    // tapback, and a reaction produces no input, so it can never cascade.
    const already = found.message.reactions.some(
      (reaction) =>
        reaction.botId === command.botId && reaction.emoji === command.emoji,
    );
    if (!already) {
      if (found.message.reactions.length >= CHANNEL_REACTION_LIMIT) {
        throw new ChannelDecodeError(
          `message "${command.messageId}" already carries ${CHANNEL_REACTION_LIMIT} reactions`,
        );
      }
      await transaction.put(found.key, {
        ...found.message,
        reactions: [
          ...found.message.reactions,
          { emoji: command.emoji, botId: command.botId, at },
        ],
      } satisfies ChannelMessageV1);
    }
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "reacted",
      channelId: current.channelId,
      messageId: command.messageId,
      emoji: command.emoji,
      botId: command.botId,
      added: !already,
    };
  }

  /**
   * Append one message and the deliveries it owes, in one transaction.
   *
   * Both bounds are checked before the first write, so a refusal rolls nothing
   * back: `hop` stops a conversation two Bots would otherwise have for ever,
   * and the token bucket stops one they would have very quickly.
   */
  async #post(
    transaction: ChannelStorageWritesV1,
    command: Extract<ChannelCommandV1, { type: "channel/post" }>,
    current: ChannelRecordV1,
    at: string,
  ): Promise<ChannelCommandReceiptV1> {
    const hop = command.hop ?? 1;
    if (hop > CHANNEL_HOP_MAX) {
      return refusal(
        command.commandId,
        "hop",
        `this message is ${hop} hops from the conversation that started it, and Channels carry at most ${CHANNEL_HOP_MAX}`,
      );
    }
    const now = this.#now().getTime();
    const bucketKey = channelBucketKeyV1(current.channelId);
    const held = await transaction.get<ChannelBucketV1>(bucketKey);
    const window =
      held && now - held.windowStartedAt < CHANNEL_RATE_WINDOW_MS
        ? held
        : { schemaVersion: 1 as const, windowStartedAt: now, count: 0 };
    if (window.count >= CHANNEL_RATE_LIMIT) {
      return refusal(
        command.commandId,
        "quota",
        `Channel "${current.channelId}" has used its ${CHANNEL_RATE_LIMIT} messages for this minute`,
      );
    }
    const cursor = channelSequenceCursorV1(
      await transaction.get<unknown>(channelSequenceKeyV1(current.channelId)),
    );
    const messageId = command.messageId ?? `cm-${command.commandId}`;
    if (!isChannelIdV1(messageId)) {
      throw new ChannelDecodeError("Channel message id is invalid");
    }
    const message = decodeChannelMessageV1({
      schemaVersion: 1,
      messageId,
      channelId: current.channelId,
      seq: cursor.nextSeq,
      // Exactly one sender. A connector delivering a remote peer's message
      // records the peer; every other post records the Bot that made it.
      ...(command.senderPeer === undefined
        ? { senderBotId: command.botId }
        : { senderPeer: command.senderPeer }),
      text: command.text,
      hop,
      at,
      reactions: [],
    } satisfies ChannelMessageV1);
    // The sender is never a recipient of its own post. This is the first of the
    // loop bounds and the cheapest: without it every post would wake the Bot
    // that made it. A *peer* is not a member, so a delivered message is owed to
    // every member including the one whose authority carried it in — otherwise
    // an external Channel, whose only member is the Bot being spoken to, would
    // deliver nothing at all.
    const recipients =
      command.senderPeer === undefined
        ? current.members.filter((member) => member !== command.botId)
        : [...current.members];
    await transaction.put(
      channelMessageKeyV1(current.channelId, message.seq),
      message,
    );
    await transaction.put(channelSequenceKeyV1(current.channelId), {
      schemaVersion: 1,
      nextSeq: message.seq + 1,
    });
    await transaction.put(bucketKey, {
      ...window,
      count: window.count + 1,
    } satisfies ChannelBucketV1);
    for (const botId of recipients) {
      await transaction.put(channelDeliveryKeyV1(message.messageId, botId), {
        schemaVersion: 1,
        channelId: current.channelId,
        messageId: message.messageId,
        botId,
        state: "pending",
      } satisfies ChannelDeliveryV1);
    }
    await this.#trimMessages(transaction, current.channelId);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "posted",
      channel: channelViewV1(current),
      message: channelMessageViewV1(message),
      recipients,
    };
  }

  async #findMessage(
    transaction: ChannelStorageWritesV1,
    channelId: string,
    messageId: string,
  ): Promise<{ key: string; message: ChannelMessageV1 } | undefined> {
    const stored = await transaction.list<unknown>({
      prefix: channelMessagePrefixV1(channelId),
      limit: CHANNEL_MESSAGE_LOG_LIMIT,
    });
    for (const [key, value] of stored) {
      const message = decodeChannelMessageV1(value);
      if (message.messageId === messageId) return { key, message };
    }
    return undefined;
  }

  /** Keep one Channel's log bounded. Trimming loses history, never authority. */
  async #trimMessages(
    transaction: ChannelStorageWritesV1,
    channelId: string,
  ): Promise<void> {
    const stored = await transaction.list<unknown>({
      prefix: channelMessagePrefixV1(channelId),
    });
    const keys = [...stored.keys()].sort();
    if (keys.length <= CHANNEL_MESSAGE_LOG_LIMIT) return;
    for (const key of keys.slice(0, keys.length - CHANNEL_MESSAGE_LOG_LIMIT)) {
      await transaction.delete(key);
    }
  }
}

/** The messages a delivered Channel input carries as its Turn's history. */
export function channelHistoryForV1(
  thread: ChannelThreadViewV1,
  limit: number,
): ChannelMessageViewV1[] {
  return thread.messages.slice(-limit);
}
