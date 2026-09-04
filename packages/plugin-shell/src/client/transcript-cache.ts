/**
 * What the client keeps of a conversation it is not currently showing.
 *
 * Clicking between Bots used to throw the transcript away and read it back:
 * every switch was an empty thread, a network round trip, and a scroll jump.
 * A Bot's conversation is small, already durable behind it, and cheap to hold,
 * so the last few are kept in memory and redrawn immediately.
 *
 * Two rules keep the cache from lying:
 *
 * - **It is keyed by conversation, not by Bot.** ADR 0027 makes "new
 *   conversation" change the Session a Bot's Turns record, so the transcript
 *   that belonged to the previous one must not come back under the same key.
 * - **A cached transcript is still revalidated.** The entry carries when it
 *   was written; past {@link TRANSCRIPT_FRESH_MS}, or once something has told
 *   the client the Bot's runs moved, the restore is followed by a read. Inside
 *   that window the click costs nothing, which is the whole point.
 *
 * The cache is memory only and never outlives the page: nothing about one
 * User's conversations reaches the next one through it.
 */
import type { WebActiveRun, WebChatMessage } from "../shared.ts";

/** How many Bots' transcripts are held before the least recent is dropped. */
export const TRANSCRIPT_CACHE_LIMIT = 8;

/**
 * How long a cached transcript is served without a read behind it. Long
 * enough that clicking between Bots is free, short enough that a conversation
 * changed on another device is never stale for long.
 */
export const TRANSCRIPT_FRESH_MS = 30_000;

/** Where the reader had the thread when they switched away. */
export interface TranscriptViewport {
  scrollTop: number;
  /**
   * True when they were at the end. Restored as "the end" rather than as the
   * pixel offset, so a transcript that grew while they were away comes back
   * pinned to the newest Turn and not to where it used to be.
   */
  pinnedToLatest: boolean;
}

/** One conversation, as the thread last drew it. */
export interface TranscriptSnapshot {
  /** Distinguishes this conversation from the next one on the same Bot. */
  conversationKey: string;
  messages: WebChatMessage[];
  activeRun?: WebActiveRun;
  activeRunId?: string;
  runningRunId?: string;
  viewport?: TranscriptViewport;
}

interface CacheEntry extends TranscriptSnapshot {
  writtenAt: number;
  stale: boolean;
}

/** A restored transcript, and whether reading it back is still owed. */
export interface TranscriptRestore extends TranscriptSnapshot {
  /** True when the caller should revalidate before trusting this for long. */
  stale: boolean;
}

export interface TranscriptCacheOptions {
  limit?: number;
  freshMs?: number;
  now?: () => number;
}

/**
 * The last few Bots' conversations, most recently used last.
 *
 * `Map` iteration order is insertion order, so "touch on read" is a delete
 * followed by a set and the first key is always the eviction candidate.
 */
export class TranscriptCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #limit: number;
  readonly #freshMs: number;
  readonly #now: () => number;

  constructor(options: TranscriptCacheOptions = {}) {
    this.#limit = options.limit ?? TRANSCRIPT_CACHE_LIMIT;
    this.#freshMs = options.freshMs ?? TRANSCRIPT_FRESH_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The Bots held, least recently used first. */
  get botIds(): readonly string[] {
    return [...this.#entries.keys()];
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The transcript for this Bot's current conversation, if it is held.
   *
   * A key mismatch is a miss and drops the entry: the conversation it holds
   * is over, and nothing will ask for it again.
   */
  take(botId: string, conversationKey: string): TranscriptRestore | undefined {
    const entry = this.#entries.get(botId);
    if (!entry) return undefined;
    if (entry.conversationKey !== conversationKey) {
      this.#entries.delete(botId);
      return undefined;
    }
    // Reading is using: this Bot is now the most recent and the last to go.
    this.#entries.delete(botId);
    this.#entries.set(botId, entry);
    return {
      conversationKey: entry.conversationKey,
      // Copies, so the caller's edits never reach back into the cache.
      messages: entry.messages.map((message) => ({ ...message })),
      ...(entry.activeRun ? { activeRun: { ...entry.activeRun } } : {}),
      ...(entry.activeRunId ? { activeRunId: entry.activeRunId } : {}),
      ...(entry.runningRunId ? { runningRunId: entry.runningRunId } : {}),
      ...(entry.viewport ? { viewport: { ...entry.viewport } } : {}),
      stale: entry.stale || this.#now() - entry.writtenAt > this.#freshMs,
    };
  }

  /** Holds this conversation, evicting the least recently used past the limit. */
  save(botId: string, snapshot: TranscriptSnapshot): void {
    // An empty transcript is not worth a slot: restoring it looks exactly like
    // the read it would have saved.
    if (snapshot.messages.length === 0) {
      this.#entries.delete(botId);
      return;
    }
    // The scroll position is written after the transcript, by the thread that
    // still has it on screen, so a save that carries none keeps the last one.
    const viewport =
      snapshot.viewport ?? this.#entries.get(botId)?.viewport ?? undefined;
    this.#entries.delete(botId);
    this.#entries.set(botId, {
      conversationKey: snapshot.conversationKey,
      messages: snapshot.messages.map((message) => ({ ...message })),
      ...(snapshot.activeRun ? { activeRun: { ...snapshot.activeRun } } : {}),
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      ...(snapshot.runningRunId ? { runningRunId: snapshot.runningRunId } : {}),
      ...(viewport ? { viewport: { ...viewport } } : {}),
      writtenAt: this.#now(),
      stale: false,
    });
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Records where the reader had the thread, without touching the transcript. */
  rememberViewport(botId: string, viewport: TranscriptViewport): void {
    const entry = this.#entries.get(botId);
    if (!entry) return;
    entry.viewport = { ...viewport };
  }

  /** Where the reader had this Bot's thread, if it is still held. */
  viewportFor(botId: string): TranscriptViewport | undefined {
    const viewport = this.#entries.get(botId)?.viewport;
    return viewport ? { ...viewport } : undefined;
  }

  /**
   * Says this Bot's runs have moved. The transcript still draws immediately —
   * a stale answer beats an empty thread — but a read follows it.
   */
  markStale(botId: string): void {
    const entry = this.#entries.get(botId);
    if (entry) entry.stale = true;
  }

  /**
   * Drops what is held for this Bot, or for every Bot.
   *
   * Called where the cached transcript would be a lie rather than merely old:
   * archive, delete, rename, and a change of signed-in User.
   */
  forget(botId?: string): void {
    if (botId === undefined) this.#entries.clear();
    else this.#entries.delete(botId);
  }
}
