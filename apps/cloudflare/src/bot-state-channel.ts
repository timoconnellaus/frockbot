import type {
  StateFrame,
  ConversationProjection,
} from "@frockbot/core/protocol-schemas";
import {
  STATE_ASSEMBLED_MAX_BYTES,
  STATE_FRAME_MAX_BYTES,
  STATE_PART_MAX_BYTES,
} from "@frockbot/core/protocol-schemas";
import { decodeBotStateCursorV1 } from "@frockbot/core/protocol";
import {
  commitPublicationsV1,
  COMPUTER_ENTITY_ID_V1,
  drainPendingPublicationV1,
  PUBLICATION_REPLAY_MAX_EVENTS_V1,
  readPublicationHeadV1,
  readReplayUpdatesV1,
  type ConversationUpdateV1,
  type PublicationHeadV1,
} from "@frockbot/core/durable";
import { readConversationSnapshotV1 } from "@frockbot/app/shell/conversation-snapshot";
import type { ReplyDraftV1 } from "@frockbot/app/shell/reply-draft";
import {
  RUN_ATTACHMENTS_PROTOCOL_V1,
  withoutRunAttachmentsV1,
} from "@frockbot/app/shell/run-protocol";
import type {
  ComputerBotStorage,
  ComputerBotTransaction,
} from "@frockbot/computer/bot";

const CHANNEL_TAG = "bot-state-v1";
/**
 * Sockets that asked for reply drafts with `drafts=1`. An observer built
 * before drafts existed decodes every frame against a schema with no
 * `state/draft` in it and would drop its socket on the first one, so a draft
 * goes only where it was asked for.
 */
const DRAFT_TAG = "bot-state-v1-drafts";
export const BOT_STATE_CHANNEL_INTERNAL_PATH = "/internal/bot-state-channel/v1";
export const BOT_STATE_CHANNEL_RETENTION = PUBLICATION_REPLAY_MAX_EVENTS_V1;

/**
 * The shortest gap between two Computer invalidations. Conversation frames
 * are not coalesced: a committed send is worth an immediate observer write.
 */
export const BOT_STATE_RUNS_NOTICE_INTERVAL_MS = 250;

export interface BotStateChannelOptionsV1 {
  /** Overridden only by tests, which cannot wait a real quarter of a second. */
  runsNoticeIntervalMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ChannelAttachmentV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  epoch: string;
  lastSent: string;
  /**
   * The client protocol the socket named when it opened. Absent on a socket
   * opened before this was recorded, and on any client that names none: both
   * are read as the oldest protocol this deployment serves.
   */
  protocol?: number;
}

/** Whether a socket is sent a Run's files, or a Run without them. */
function currentProtocol(attachment: ChannelAttachmentV1): boolean {
  return (attachment.protocol ?? 2) >= RUN_ATTACHMENTS_PROTOCOL_V1;
}

/** The frames for one socket's protocol, stripped once and only if needed. */
class ProtocolFrames {
  private readonly frame: CursoredFrameV1;
  private readonly current: string[];
  private legacy: string[] | undefined;
  constructor(frame: CursoredFrameV1) {
    this.frame = frame;
    this.current = framesFor(frame);
  }
  for(attachment: ChannelAttachmentV1): string[] {
    if (currentProtocol(attachment)) return this.current;
    this.legacy ??= framesFor(withoutRunAttachmentsV1(this.frame));
    return this.legacy;
  }
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function encodeFrame(frame: StateFrame): string {
  return JSON.stringify(frame);
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + maxBytes, bytes.length);
    if (end < bytes.length) {
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    if (end <= offset) end = Math.min(offset + maxBytes, bytes.length);
    parts.push(utf8Decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return parts;
}

/** A frame on the publication's cursor: every kind but a draft. */
type CursoredFrameV1 = Exclude<StateFrame, { type: "state/draft" }>;

function framesFor(frame: CursoredFrameV1): string[] {
  const encoded = encodeFrame(frame);
  if (utf8.encode(encoded).length <= STATE_FRAME_MAX_BYTES) return [encoded];
  if (frame.type === "state/ready" || frame.type === "state/part") {
    throw new Error("Bot-state frame exceeds the bound");
  }
  const chunks = splitUtf8(encoded, STATE_PART_MAX_BYTES);
  if (chunks.length > 256) {
    throw new Error("Bot-state frame exceeds the assembled bound");
  }
  let assembled = 0;
  const parts: string[] = [];
  for (const [index, data] of chunks.entries()) {
    assembled += utf8.encode(data).length;
    if (assembled > STATE_ASSEMBLED_MAX_BYTES) {
      throw new Error("Bot-state frame exceeds the assembled bound");
    }
    parts.push(
      encodeFrame({
        schemaVersion: 1,
        type: "state/part",
        epoch: frame.epoch,
        cursor: frame.cursor,
        eventId: `${frame.epoch}:${frame.cursor}`,
        part: index,
        parts: chunks.length,
        data,
      }),
    );
  }
  return parts;
}

export type HandshakeReasonV1 =
  "initial" | "gap" | "cursor-ahead" | "epoch" | "replay";

/** Which handshake to send for a presented epoch/cursor. */
export function planHandshakeV1(
  head: PublicationHeadV1,
  cursor: number | undefined,
  epoch: number | undefined,
): HandshakeReasonV1 {
  if (cursor === undefined) return "initial";
  if (epoch !== head.epoch) return "epoch";
  if (cursor > head.lastCursor) return "cursor-ahead";
  if (cursor < head.firstRetainedCursor - 1) return "gap";
  return "replay";
}

function updateFrame(update: ConversationUpdateV1): CursoredFrameV1 {
  return {
    schemaVersion: 1,
    type: "state/update",
    epoch: String(update.epoch),
    cursor: String(update.cursor),
    kind: update.kind,
    entityId: update.entityId,
    revision: update.revision,
    payload: (update.payload ?? {}) as StateFrame extends {
      type: "state/update";
      payload: infer Payload;
    }
      ? Payload
      : never,
  };
}

function decodeAttachment(value: unknown): ChannelAttachmentV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const attachment = value as ChannelAttachmentV1;
  const keys = Object.keys(value).length;
  if (
    keys !== (attachment.protocol === undefined ? 5 : 6) ||
    attachment.schemaVersion !== 1 ||
    typeof attachment.userId !== "string" ||
    !attachment.userId ||
    typeof attachment.botId !== "string" ||
    !attachment.botId ||
    (attachment.protocol !== undefined &&
      !Number.isSafeInteger(attachment.protocol))
  ) {
    return undefined;
  }
  try {
    decodeBotStateCursorV1(attachment.lastSent);
    decodeBotStateCursorV1(attachment.epoch);
  } catch {
    return undefined;
  }
  return attachment;
}

/**
 * A storage facade which appends a Computer invalidation and asks the Bot
 * authority to recompute its one alarm in the same transaction as each
 * authoritative Computer write. The append and schedule are durable;
 * delivery to attached observers happens only after that transaction commits.
 */
class ChannelComputerStorage implements ComputerBotStorage {
  constructor(
    private readonly channel: BotStateChannel,
    private readonly storage: DurableObjectStorage,
  ) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  async put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      if (typeof keyOrEntries === "string") {
        await transaction.put(keyOrEntries, value);
      } else {
        await transaction.put(keyOrEntries);
      }
      await this.channel.commitComputer(transaction);
      await this.channel.refreshAlarm(transaction);
    });
    await this.channel.drainBroadcast();
  }

  async delete(key: string): Promise<boolean> {
    let deleted = false;
    await this.storage.transaction(async (transaction) => {
      deleted = await transaction.delete(key);
      if (deleted) {
        await this.channel.commitComputer(transaction);
        await this.channel.refreshAlarm(transaction);
      }
    });
    if (deleted) await this.channel.drainBroadcast();
    return deleted;
  }

  async transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T> {
    let changed = false;
    const result = await this.storage.transaction(async (transaction) => {
      const wrapped: ComputerBotTransaction = {
        get: <Value>(key: string) => transaction.get<Value>(key),
        put: async <Value>(
          keyOrEntries: string | Record<string, unknown>,
          value?: Value,
        ) => {
          changed = true;
          if (typeof keyOrEntries === "string") {
            await transaction.put(keyOrEntries, value);
          } else {
            await transaction.put(keyOrEntries);
          }
        },
        delete: async (key: string) => {
          const result = await transaction.delete(key);
          changed ||= result;
          return result;
        },
      };
      const value = await callback(wrapped);
      if (changed) {
        await this.channel.commitComputer(transaction);
        await this.channel.refreshAlarm(transaction);
      }
      return value;
    });
    if (changed) await this.channel.drainBroadcast();
    return result;
  }
}

export class BotStateChannel {
  readonly computerStorage: ComputerBotStorage;
  private alarmRefresher:
    ((transaction: DurableObjectTransaction) => Promise<void>) | undefined;
  private computerNotice: Promise<void> | undefined;
  private computerPending = false;
  private computerNoticeAt = 0;
  private readonly runsNoticeIntervalMs: number;
  private silenced = false;

  constructor(
    private readonly state: DurableObjectState,
    options: BotStateChannelOptionsV1 = {},
  ) {
    this.computerStorage = new ChannelComputerStorage(this, state.storage);
    this.runsNoticeIntervalMs =
      options.runsNoticeIntervalMs ?? BOT_STATE_RUNS_NOTICE_INTERVAL_MS;
  }

  /**
   * The kernel's own alarm refresher, set by whichever mount is current.
   *
   * A mount that failed is retried, and the retry brings a new refresher bound
   * to the Contribution that actually mounted — so the last writer wins rather
   * than the first. Refusing the second one turned a recovered mount into a
   * different, permanent failure.
   */
  setAlarmRefresher(
    refresh: (transaction: DurableObjectTransaction) => Promise<void>,
  ): void {
    this.alarmRefresher = refresh;
  }

  async commitComputer(
    transaction: DurableObjectTransaction,
  ): Promise<ConversationUpdateV1[]> {
    return commitPublicationsV1(transaction, [
      {
        kind: "computer",
        entityId: COMPUTER_ENTITY_ID_V1,
        payload: {},
      },
    ]);
  }

  /**
   * Delivers one bounded batch of committed publication to attached
   * observers, then advances `broadcastThrough`. Missing subscribers still
   * complete the attempt so an idle object is not kept awake.
   */
  async drainBroadcast(): Promise<boolean> {
    if (this.silenced) return false;
    return drainPendingPublicationV1(
      this.state.storage,
      (updates) => {
        this.broadcastCommitted(updates);
      },
      {
        refreshAlarm: (transaction) =>
          this.refreshAlarm(transaction as unknown as DurableObjectTransaction),
      },
    );
  }

  /**
   * Broadcasts already-committed updates over hibernating observer sockets.
   * Delivery is an attempt: one slow reader cannot hold the Turn, and a
   * crash after send but before the marker may repeat frames.
   */
  broadcastCommitted(updates: readonly ConversationUpdateV1[]): void {
    if (this.silenced || updates.length === 0) return;
    for (const update of updates) {
      let frames: ProtocolFrames;
      try {
        frames = new ProtocolFrames(updateFrame(update));
      } catch {
        continue;
      }
      this.sendFrames(frames, update.epoch, update.cursor);
    }
  }

  /**
   * Shows the reply a running Turn is writing to every observer that asked
   * for drafts. Nothing is appended: a draft has no cursor, a reconnect does
   * not replay it, and the message it previews is the committed record. One
   * too large for a single frame is not sent, so the draft stops growing
   * there and the message still arrives whole.
   */
  broadcastDraft(draft: ReplyDraftV1): void {
    if (this.silenced) return;
    const encoded = encodeFrame({
      schemaVersion: 1,
      type: "state/draft",
      runId: draft.runId,
      ordinal: draft.ordinal,
      parts: draft.parts,
    });
    if (utf8.encode(encoded).length > STATE_FRAME_MAX_BYTES) return;
    for (const socket of this.state.getWebSockets(DRAFT_TAG)) {
      try {
        socket.send(encoded);
      } catch {
        // A socket that cannot take a preview fails its next committed frame
        // too, and that path closes it.
      }
    }
  }

  /**
   * Append and broadcast one `computer` invalidation for a write the Bot made
   * outside this Durable Object's storage.
   *
   * A screenshot the Bot files mid-Turn lands in the Workspace, not in DO
   * storage, so no `ChannelComputerStorage` write announces it. Coalesced on
   * the Computer interval: a Turn running Computer actions back to back only
   * ever needs the browser to know it should read again.
   */
  noticeComputer(): void {
    if (this.silenced) return;
    this.computerPending = true;
    if (this.computerNotice) return;
    this.computerNotice = (async () => {
      while (this.computerPending) {
        const wait =
          this.runsNoticeIntervalMs - (Date.now() - this.computerNoticeAt);
        if (wait > 0) await delay(wait);
        this.computerPending = false;
        this.computerNoticeAt = Date.now();
        if (this.silenced) return;
        await this.state.storage.transaction(async (transaction) => {
          await this.commitComputer(transaction);
          await this.refreshAlarm(transaction);
        });
        await this.drainBroadcast();
      }
    })()
      .catch(() => {
        // An observer notice is never authority. A dropped one costs the
        // client its next poll, and the capture it described stands.
      })
      .finally(() => {
        this.computerNotice = undefined;
      });
  }

  /**
   * Stops this channel writing, for good. Called by the Bot's teardown before
   * it wipes storage.
   */
  silence(): void {
    this.silenced = true;
    this.computerPending = false;
  }

  /** The configured callback belongs to the kernel; Packages contribute only deadlines. */
  refreshAlarm(transaction: DurableObjectTransaction): Promise<void> {
    return this.alarmRefresher?.(transaction) ?? Promise.resolve();
  }

  private sendFrames(
    frames: ProtocolFrames,
    epoch: number,
    cursor: number,
  ): void {
    for (const socket of this.state.getWebSockets(CHANNEL_TAG)) {
      try {
        const attachment = decodeAttachment(socket.deserializeAttachment());
        if (!attachment || Number(attachment.epoch) !== epoch) continue;
        if (Number(attachment.lastSent) >= cursor) continue;
        for (const frame of frames.for(attachment)) socket.send(frame);
        socket.serializeAttachment({
          ...attachment,
          lastSent: String(cursor),
        } satisfies ChannelAttachmentV1);
      } catch {
        try {
          socket.close(1011, "delivery failed");
        } catch {
          // A detached observer has no bearing on the durable operation.
        }
      }
    }
  }

  async upgrade(
    request: Request,
    identity: { userId: string; botId: string },
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }
    const url = new URL(request.url);
    if (url.searchParams.get("version") !== "1") {
      return Response.json(
        { error: "unsupported Bot-state protocol" },
        { status: 400 },
      );
    }
    const drafts = url.searchParams.get("drafts") === "1";
    const presentedCursor = url.searchParams.get("cursor");
    const presentedEpoch = url.searchParams.get("epoch");
    // A browser cannot put a header on a WebSocket, so the client names its
    // protocol here. One that names none is the oldest this deployment serves.
    const presentedProtocol = Number(url.searchParams.get("protocol") ?? "2");
    const protocol =
      Number.isSafeInteger(presentedProtocol) && presentedProtocol > 0
        ? presentedProtocol
        : 2;
    let cursor: number | undefined;
    let epoch: number | undefined;
    if (presentedCursor !== null) {
      try {
        cursor = Number(decodeBotStateCursorV1(presentedCursor));
      } catch {
        return Response.json(
          { error: "invalid Bot-state cursor" },
          { status: 400 },
        );
      }
    }
    if (presentedEpoch !== null) {
      try {
        epoch = Number(decodeBotStateCursorV1(presentedEpoch));
      } catch {
        return Response.json(
          { error: "invalid Bot-state epoch" },
          { status: 400 },
        );
      }
    }

    // Keep the snapshot and socket registration contiguous with respect to
    // other object events. Otherwise a write could commit after the snapshot
    // but before the socket is registered, silently skipping its update.
    return this.state.blockConcurrencyWhile(async () => {
      const handshake = await this.state.storage.transaction(
        async (transaction) => {
          const head = await readPublicationHeadV1(transaction);
          const conversation = await readConversationSnapshotV1(transaction);
          return this.handshakeFrames(
            transaction,
            head,
            conversation,
            cursor,
            epoch,
          );
        },
      );

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(
        server,
        drafts ? [CHANNEL_TAG, DRAFT_TAG] : [CHANNEL_TAG],
      );
      const attachment = {
        schemaVersion: 1,
        ...identity,
        epoch: handshake.epoch,
        lastSent: handshake.lastSent,
        protocol,
      } satisfies ChannelAttachmentV1;
      server.serializeAttachment(attachment);
      for (const frame of handshake.frames) {
        try {
          for (const encoded of new ProtocolFrames(frame).for(attachment))
            server.send(encoded);
        } catch {
          server.close(1011, "handshake failed");
          return new Response(null, { status: 101, webSocket: client });
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  private async handshakeFrames(
    storage: {
      get<T>(key: string): Promise<T | undefined>;
    },
    head: PublicationHeadV1,
    conversation: Awaited<ReturnType<typeof readConversationSnapshotV1>>,
    cursor: number | undefined,
    epoch: number | undefined,
  ): Promise<{ epoch: string; lastSent: string; frames: CursoredFrameV1[] }> {
    const snapshot = (
      reason: "initial" | "gap" | "cursor-ahead" | "epoch",
    ): CursoredFrameV1 => ({
      schemaVersion: 1,
      type: "state/snapshot",
      epoch: String(head.epoch),
      cursor: String(head.lastCursor),
      reason,
      conversation: conversation as ConversationProjection,
    });
    const ready: CursoredFrameV1 = {
      schemaVersion: 1,
      type: "state/ready",
      epoch: String(head.epoch),
      cursor: String(head.lastCursor),
    };
    const withReady = (frames: CursoredFrameV1[]) => ({
      epoch: String(head.epoch),
      lastSent: String(head.lastCursor),
      frames: [...frames, ready],
    });
    const reason = planHandshakeV1(head, cursor, epoch);
    if (reason !== "replay") {
      return withReady([snapshot(reason)]);
    }
    try {
      const updates = await readReplayUpdatesV1(storage, head, cursor!);
      return withReady(updates.map(updateFrame));
    } catch {
      return withReady([snapshot("gap")]);
    }
  }

  message(socket: WebSocket): void {
    socket.close(1003, "server-push channel");
  }

  close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Hibernation cleanup only; observer state is never authoritative.
    }
  }

  error(socket: WebSocket): void {
    try {
      socket.close(1011, "socket error");
    } catch {
      // Hibernation cleanup only; observer state is never authoritative.
    }
  }
}
