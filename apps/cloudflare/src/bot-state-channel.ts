import type {
  BotStateChannelFrameV1,
  BotStateTopicV1,
} from "@frockbot/protocol";
import { decodeBotStateCursorV1 } from "@frockbot/protocol";
import type {
  ComputerBotStorage,
  ComputerBotTransaction,
} from "@frockbot/plugin-computer/bot";

const CHANNEL_TAG = "bot-state-v1";
export const BOT_STATE_CHANNEL_INTERNAL_PATH = "/internal/bot-state-channel/v1";
const CHANNEL_META_KEY = "bot-state-channel:meta:v1";
const CHANNEL_EVENT_PREFIX = "bot-state-channel:event:v1:";
export const BOT_STATE_CHANNEL_RETENTION = 64;

/**
 * The shortest gap between two `runs` invalidations.
 *
 * A Turn's answer is journaled a text delta at a time, so a streaming reply
 * lands one durable run write per token and, uncoalesced, one notice and one
 * `GET /turns` per token with it. The observer only ever needs to know that it
 * should read again, so the burst is spread: the first write notices at once —
 * a Turn that starts, ends, or says one short thing is never delayed — and
 * everything behind it is collapsed into one notice per interval. The last
 * write always gets a notice, because the pending flag outlives the wait.
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

interface ChannelMetaV1 {
  schemaVersion: 1;
  first: number;
  last: number;
}

interface ChannelAttachmentV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  lastSent: string;
}

interface StoredChannelEventV1 {
  schemaVersion: 1;
  cursor: string;
  topic: BotStateTopicV1;
}

function eventKey(cursor: number): string {
  return `${CHANNEL_EVENT_PREFIX}${String(cursor).padStart(16, "0")}`;
}

function decodeMeta(value: unknown): ChannelMetaV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as ChannelMetaV1).schemaVersion !== 1 ||
    !Number.isSafeInteger((value as ChannelMetaV1).first) ||
    !Number.isSafeInteger((value as ChannelMetaV1).last) ||
    (value as ChannelMetaV1).first < 1 ||
    (value as ChannelMetaV1).last < (value as ChannelMetaV1).first
  ) {
    throw new Error("Bot-state channel metadata is corrupt");
  }
  return value as ChannelMetaV1;
}

function decodeStoredEvent(value: unknown): StoredChannelEventV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    (value as StoredChannelEventV1).schemaVersion !== 1 ||
    ((value as StoredChannelEventV1).topic !== "computer" &&
      (value as StoredChannelEventV1).topic !== "runs")
  ) {
    throw new Error("Bot-state channel event is corrupt");
  }
  const event = value as StoredChannelEventV1;
  decodeBotStateCursorV1(event.cursor);
  return event;
}

function decodeAttachment(value: unknown): ChannelAttachmentV1 | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4
  ) {
    return undefined;
  }
  const attachment = value as ChannelAttachmentV1;
  if (
    attachment.schemaVersion !== 1 ||
    typeof attachment.userId !== "string" ||
    !attachment.userId ||
    typeof attachment.botId !== "string" ||
    !attachment.botId
  ) {
    return undefined;
  }
  try {
    decodeBotStateCursorV1(attachment.lastSent);
  } catch {
    return undefined;
  }
  return attachment;
}

function encodeFrame(frame: BotStateChannelFrameV1): string {
  return JSON.stringify(frame);
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
    let event: StoredChannelEventV1 | undefined;
    await this.storage.transaction(async (transaction) => {
      if (typeof keyOrEntries === "string") {
        await transaction.put(keyOrEntries, value);
      } else {
        await transaction.put(keyOrEntries);
      }
      event = await this.channel.append(transaction, "computer");
      await this.channel.refreshAlarm(transaction);
    });
    this.channel.broadcast(event);
  }

  async delete(key: string): Promise<boolean> {
    let deleted = false;
    let event: StoredChannelEventV1 | undefined;
    await this.storage.transaction(async (transaction) => {
      deleted = await transaction.delete(key);
      if (deleted) {
        event = await this.channel.append(transaction, "computer");
        await this.channel.refreshAlarm(transaction);
      }
    });
    this.channel.broadcast(event);
    return deleted;
  }

  async transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T> {
    let event: StoredChannelEventV1 | undefined;
    const result = await this.storage.transaction(async (transaction) => {
      let changed = false;
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
        event = await this.channel.append(transaction, "computer");
        await this.channel.refreshAlarm(transaction);
      }
      return value;
    });
    this.channel.broadcast(event);
    return result;
  }
}

/**
 * The durable keys that hold what a browser draws as the conversation: the
 * run records themselves, their index, and the two pointers that say which
 * Turn is executing and which is waiting. A write to any of them means the
 * transcript moved.
 */
const RUN_STATE_KEY_PREFIXES = ["run:", "run-index:"] as const;
const RUN_STATE_KEYS = ["active-run", "pending-run"] as const;

function namesRunState(key: string): boolean {
  return (
    RUN_STATE_KEYS.some((named) => named === key) ||
    RUN_STATE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function writtenKeys(keyOrEntries: unknown): readonly string[] {
  if (typeof keyOrEntries === "string") return [keyOrEntries];
  if (Array.isArray(keyOrEntries)) {
    return keyOrEntries.filter((key): key is string => typeof key === "string");
  }
  if (keyOrEntries && typeof keyOrEntries === "object") {
    return Object.keys(keyOrEntries as Record<string, unknown>);
  }
  return [];
}

export class BotStateChannel {
  readonly computerStorage: ComputerBotStorage;
  private alarmRefresher:
    ((transaction: DurableObjectTransaction) => Promise<void>) | undefined;
  /** The in-flight `runs` notice, and whether another write arrived behind it. */
  private runsNotice: Promise<void> | undefined;
  private runsPending = false;
  /** When the last `runs` notice was appended; the throttle's only clock. */
  private runsNoticeAt = 0;
  private readonly runsNoticeIntervalMs: number;
  /** The same coalescing pair for `computer`, which a Turn writes as often. */
  private computerNotice: Promise<void> | undefined;
  private computerPending = false;
  private computerNoticeAt = 0;

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

  /**
   * This object's storage, seen through the channel: any committed write to a
   * run record appends a `runs` invalidation and pushes it to attached
   * observers. The frame is advisory — a client that receives one re-reads
   * `GET /api/bots/:bot/turns` — so the notice is deliberately outside the
   * caller's transaction: it must never be able to fail an authoritative
   * write, and a notice for a rolled-back write costs one redundant read.
   *
   * The authority is handed this in place of the raw Durable Object state, so
   * the kernel stays unaware that anybody is watching.
   */
  observeRuns(state: DurableObjectState): DurableObjectState {
    const channel = this;
    const source = state.storage;
    const observe = (keys: readonly string[]): void => {
      if (keys.some(namesRunState)) channel.noticeRuns();
    };
    const wrapTransaction = (
      transaction: DurableObjectTransaction,
    ): DurableObjectTransaction =>
      new Proxy(transaction, {
        get(target, property) {
          if (property === "put" || property === "delete") {
            return (...args: unknown[]) => {
              observe(writtenKeys(args[0]));
              return (target[property] as (...input: unknown[]) => unknown)(
                ...args,
              );
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DurableObjectTransaction;
    const storage = new Proxy(source, {
      get(target, property) {
        if (property === "put" || property === "delete") {
          return (...args: unknown[]) => {
            const keys = writtenKeys(args[0]);
            const result = (
              target[property] as (...input: unknown[]) => unknown
            )(...args);
            return result instanceof Promise
              ? result.then((value) => {
                  observe(keys);
                  return value;
                })
              : result;
          };
        }
        if (property === "transaction") {
          return <T>(
            callback: (transaction: DurableObjectTransaction) => Promise<T>,
          ) =>
            target.transaction((transaction) =>
              callback(wrapTransaction(transaction)),
            );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableObjectStorage;
    return new Proxy(state, {
      get(target, property) {
        if (property === "storage") return storage;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableObjectState;
  }

  /**
   * Append and broadcast one `runs` invalidation, coalescing the burst a
   * single Turn produces: a Turn writes its run record on admission, on every
   * session flush and on settlement, and an observer only ever needs to know
   * that it should read again.
   */
  private noticeRuns(): void {
    this.runsPending = true;
    if (this.runsNotice) return;
    this.runsNotice = (async () => {
      while (this.runsPending) {
        // A notice inside the interval since the last one waits out the
        // remainder, so a streaming answer's per-token writes become one
        // notice per interval rather than one each. Whatever arrived during
        // the wait is still pending, so the loop runs again and the final
        // write always notices.
        const wait =
          this.runsNoticeIntervalMs - (Date.now() - this.runsNoticeAt);
        if (wait > 0) await delay(wait);
        this.runsPending = false;
        this.runsNoticeAt = Date.now();
        let event: StoredChannelEventV1 | undefined;
        await this.state.storage.transaction(async (transaction) => {
          event = await this.append(transaction, "runs");
        });
        this.broadcast(event);
      }
    })()
      .catch(() => {
        // An observer notice is never authority. A dropped one costs the
        // client its next poll, and the durable write it described stands.
      })
      .finally(() => {
        this.runsNotice = undefined;
      });
  }

  /**
   * Append and broadcast one `computer` invalidation for a write the Bot made
   * outside this Durable Object's storage.
   *
   * A screenshot the Bot files mid-Turn lands in the Workspace, not in DO
   * storage, so no `ChannelComputerStorage` write announces it and an
   * attached browser would not read the fresher capture until its next poll.
   * Coalesced on the same interval as `runs`: a Turn running Computer actions
   * back to back only ever needs the browser to know it should read again.
   */
  noticeComputer(): void {
    this.computerPending = true;
    if (this.computerNotice) return;
    this.computerNotice = (async () => {
      while (this.computerPending) {
        const wait =
          this.runsNoticeIntervalMs - (Date.now() - this.computerNoticeAt);
        if (wait > 0) await delay(wait);
        this.computerPending = false;
        this.computerNoticeAt = Date.now();
        let event: StoredChannelEventV1 | undefined;
        await this.state.storage.transaction(async (transaction) => {
          event = await this.append(transaction, "computer");
        });
        this.broadcast(event);
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

  /** The configured callback belongs to the kernel; Packages contribute only deadlines. */
  refreshAlarm(transaction: DurableObjectTransaction): Promise<void> {
    return this.alarmRefresher?.(transaction) ?? Promise.resolve();
  }

  async append(
    transaction: DurableObjectTransaction,
    topic: BotStateTopicV1,
  ): Promise<StoredChannelEventV1> {
    const storedMeta = await transaction.get<unknown>(CHANNEL_META_KEY);
    const previous =
      storedMeta === undefined ? undefined : decodeMeta(storedMeta);
    const last = (previous?.last ?? 0) + 1;
    if (!Number.isSafeInteger(last)) {
      throw new Error("Bot-state channel cursor is exhausted");
    }
    const first = Math.max(
      previous?.first ?? 1,
      last - BOT_STATE_CHANNEL_RETENTION + 1,
    );
    const event = {
      schemaVersion: 1,
      cursor: String(last),
      topic,
    } satisfies StoredChannelEventV1;
    await transaction.put({
      [CHANNEL_META_KEY]: {
        schemaVersion: 1,
        first,
        last,
      } satisfies ChannelMetaV1,
      [eventKey(last)]: event,
    });
    if (previous && first > previous.first) {
      await transaction.delete(eventKey(previous.first));
    }
    return event;
  }

  broadcast(event: StoredChannelEventV1 | undefined): void {
    if (!event) return;
    for (const socket of this.state.getWebSockets(CHANNEL_TAG)) {
      try {
        const attachment = decodeAttachment(socket.deserializeAttachment());
        if (
          !attachment ||
          Number(attachment.lastSent) >= Number(event.cursor)
        ) {
          continue;
        }
        socket.send(
          encodeFrame({
            schemaVersion: 1,
            type: "state/event",
            cursor: event.cursor,
            topic: event.topic,
          }),
        );
        socket.serializeAttachment({
          ...attachment,
          lastSent: event.cursor,
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
    const presentedCursor = url.searchParams.get("cursor");
    let cursor: number | undefined;
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

    // Keep the replay snapshot and socket registration contiguous with respect
    // to other object events. Otherwise a Computer write could commit after
    // the snapshot but before the socket is registered, silently skipping its
    // invalidation.
    return this.state.blockConcurrencyWhile(async () => {
      const replay = await this.state.storage.transaction(
        async (transaction) => {
          const value = await transaction.get<unknown>(CHANNEL_META_KEY);
          const meta = value === undefined ? undefined : decodeMeta(value);
          const last = meta?.last ?? 0;
          if (cursor === undefined) {
            return {
              last,
              frames: [
                {
                  schemaVersion: 1,
                  type: "state/reset",
                  cursor: String(last),
                  reason: "initial",
                } satisfies BotStateChannelFrameV1,
              ],
            };
          }
          if (cursor > last) {
            return {
              last,
              frames: [
                {
                  schemaVersion: 1,
                  type: "state/reset",
                  cursor: String(last),
                  reason: "cursor-ahead",
                } satisfies BotStateChannelFrameV1,
              ],
            };
          }
          if (meta && cursor < meta.first - 1) {
            return {
              last,
              frames: [
                {
                  schemaVersion: 1,
                  type: "state/reset",
                  cursor: String(last),
                  reason: "gap",
                } satisfies BotStateChannelFrameV1,
              ],
            };
          }
          const frames: BotStateChannelFrameV1[] = [];
          for (let next = cursor + 1; next <= last; next += 1) {
            const stored = decodeStoredEvent(
              await transaction.get<unknown>(eventKey(next)),
            );
            frames.push({
              schemaVersion: 1,
              type: "state/event",
              cursor: stored.cursor,
              topic: stored.topic,
            });
          }
          return { last, frames };
        },
      );

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [CHANNEL_TAG]);
      server.serializeAttachment({
        schemaVersion: 1,
        ...identity,
        lastSent: String(replay.last),
      } satisfies ChannelAttachmentV1);
      for (const frame of replay.frames) server.send(encodeFrame(frame));
      server.send(
        encodeFrame({
          schemaVersion: 1,
          type: "state/ready",
          cursor: String(replay.last),
        }),
      );
      return new Response(null, { status: 101, webSocket: client });
    });
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
