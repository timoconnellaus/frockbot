import {
  decodeSessionEvent,
  type LlmMessage,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import {
  LATEST_EVENTS_KEY,
  RUN_PREFIX,
  SESSION_EVENT_LOG_INDEX_PREFIX,
  SESSION_EVENT_LOG_PAGE_PREFIX,
  SESSION_EVENT_PAYLOAD_PREFIX,
} from "./storage-keys.js";

/** Maximum serialized size of one Session page value. */
export const SESSION_EVENT_PAGE_BYTES_V1 = 256 * 1024;
/** Events at or below this size may live directly in a page. */
export const SESSION_EVENT_INLINE_BYTES_V1 = 16 * 1024;
/** Maximum UTF-8 bytes retained in a cut event's diagnostic excerpt. */
export const SESSION_EVENT_EXCERPT_BYTES_V1 = 8 * 1024;
/** Payload chunks stay well below both the page and SQLite value ceilings. */
export const SESSION_EVENT_PAYLOAD_CHUNK_BYTES_V1 = 128 * 1024;

const encoder = new TextEncoder();

export interface SessionEventLogStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

interface SessionEventLogIndexV1 {
  schemaVersion: 1;
  sessionId: string;
  eventCount: number;
  pageCount: number;
}

interface StoredSessionEventPageV1 {
  schemaVersion: 1;
  sessionId: string;
  page: number;
  startSeq: number;
  entries: StoredSessionEventV1[];
}

interface StoredSessionEventInlineV1 {
  storage: "inline";
  event: SessionEvent;
}

/**
 * A bounded durable projection plus a reference to the exact event payload.
 * `projection.cut` is intentionally explicit: debug readers never mistake an
 * excerpt for the event the model actually ran on.
 */
export interface StoredSessionEventCutV1 {
  storage: "cut";
  projection: Record<string, unknown> & {
    type: string;
    seq: number;
    timestamp: string;
    cut: {
      marker: "content-cut";
      originalBytes: number;
      sha256: string;
    };
  };
  payload: {
    chunks: number;
    bytes: number;
    sha256: string;
  };
}

type StoredSessionEventV1 =
  StoredSessionEventInlineV1 | StoredSessionEventCutV1;

function utf8Bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function sessionKeyPart(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function sessionEventLogIndexKeyV1(sessionId: string): string {
  return `${SESSION_EVENT_LOG_INDEX_PREFIX}${sessionKeyPart(sessionId)}`;
}

export function sessionEventLogPagePrefixV1(sessionId: string): string {
  return `${SESSION_EVENT_LOG_PAGE_PREFIX}${sessionKeyPart(sessionId)}:`;
}

function sessionEventLogPageKey(sessionId: string, page: number): string {
  return `${sessionEventLogPagePrefixV1(sessionId)}${String(page).padStart(10, "0")}`;
}

export function sessionEventPayloadPrefixV1(sessionId: string): string {
  return `${SESSION_EVENT_PAYLOAD_PREFIX}${sessionKeyPart(sessionId)}:`;
}

function sessionEventPayloadKey(
  sessionId: string,
  seq: number,
  chunk: number,
): string {
  return `${sessionEventPayloadPrefixV1(sessionId)}${String(seq).padStart(12, "0")}:${String(chunk).padStart(6, "0")}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cutUtf8(value: string, maximum: number): string {
  if (encoder.encode(value).byteLength <= maximum) return value;
  const marker = "\n[… content cut …]";
  const budget = maximum - encoder.encode(marker).byteLength;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= budget)
      low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${marker}`;
}

function messageExcerpt(message: LlmMessage | undefined): string {
  if (!message) return "";
  if (message.role === "assistant")
    return `${message.role}: ${message.content}`;
  if (message.role === "tool") {
    return `${message.role}(${message.name}): ${message.content}`;
  }
  return `${message.role}: ${message.content}`;
}

function eventCoordinates(event: SessionEvent): {
  type: string;
  seq: number;
  timestamp: string;
  turn?: number;
  step?: number;
} {
  const record = event as unknown as Record<string, unknown>;
  return {
    type: event.type,
    seq: event.seq,
    timestamp: event.timestamp,
    ...(typeof record.turn === "number" ? { turn: record.turn } : {}),
    ...(typeof record.step === "number" ? { step: record.step } : {}),
  };
}

async function cutProjection(
  event: SessionEvent,
  serialized: string,
  digest: string,
): Promise<StoredSessionEventCutV1["projection"]> {
  const base = eventCoordinates(event);
  const cut = {
    marker: "content-cut" as const,
    originalBytes: encoder.encode(serialized).byteLength,
    sha256: digest,
  };
  if (event.type === "model/request") {
    const requestSerialized = JSON.stringify(event.request);
    const requestBytes = encoder.encode(requestSerialized).byteLength;
    const requestDigest = await sha256(requestSerialized);
    const lastMessage = event.request.messages.at(-1);
    const excerptPartBytes = Math.floor(SESSION_EVENT_EXCERPT_BYTES_V1 / 2);
    return {
      ...base,
      cut,
      request: {
        requestId: event.request.requestId,
        provider: event.request.provider,
        model: event.request.model,
        ...(event.request.modelBinding
          ? { modelBinding: event.request.modelBinding }
          : {}),
        messageCount: event.request.messages.length,
        toolCount: event.request.tools.length,
        bytes: requestBytes,
        sha256: requestDigest,
        excerpt: {
          system: cutUtf8(event.request.system, excerptPartBytes),
          lastMessage: cutUtf8(messageExcerpt(lastMessage), excerptPartBytes),
        },
        truncated: true,
      },
    };
  }
  const record = event as unknown as Record<string, unknown>;
  const named = [
    "requestId",
    "messageId",
    "occurrenceId",
    "effectId",
    "callId",
    "name",
    "packageId",
    "status",
    "outcome",
    "isError",
  ].reduce<Record<string, unknown>>((kept, key) => {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      kept[key] = value;
    }
    return kept;
  }, {});
  return {
    ...base,
    ...named,
    cut,
    excerpt: cutUtf8(serialized, SESSION_EVENT_EXCERPT_BYTES_V1),
    truncated: true,
  };
}

function payloadChunks(serialized: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < serialized.length) {
    let end = Math.min(serialized.length, offset + 32_000);
    while (
      end > offset &&
      encoder.encode(serialized.slice(offset, end)).byteLength >
        SESSION_EVENT_PAYLOAD_CHUNK_BYTES_V1
    ) {
      end -= 1;
    }
    if (end === offset)
      throw new Error("Session event payload cannot be chunked");
    chunks.push(serialized.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function requireIndex(
  input: SessionEventLogIndexV1 | undefined,
  sessionId: string,
): SessionEventLogIndexV1 | undefined {
  if (input === undefined) return undefined;
  if (
    input.schemaVersion !== 1 ||
    input.sessionId !== sessionId ||
    !Number.isSafeInteger(input.eventCount) ||
    input.eventCount < 0 ||
    !Number.isSafeInteger(input.pageCount) ||
    input.pageCount < 0
  ) {
    throw new Error(`Session event index for "${sessionId}" is invalid`);
  }
  return input;
}

function requirePage(
  input: StoredSessionEventPageV1 | undefined,
  sessionId: string,
  page: number,
): StoredSessionEventPageV1 {
  if (
    !input ||
    input.schemaVersion !== 1 ||
    input.sessionId !== sessionId ||
    input.page !== page ||
    !Number.isSafeInteger(input.startSeq) ||
    input.startSeq < 0 ||
    !Array.isArray(input.entries) ||
    utf8Bytes(input) > SESSION_EVENT_PAGE_BYTES_V1
  ) {
    throw new Error(`Session event page ${page} for "${sessionId}" is invalid`);
  }
  return input;
}

/**
 * Durable Session log module. Its interface hides paging, large-event
 * projection, exact-payload chunks, integrity checks, and legacy migration.
 */
export class SessionEventLog {
  constructor(private readonly storage: SessionEventLogStorage) {}

  async read(sessionId: string): Promise<SessionEvent[]> {
    const index = requireIndex(
      await this.storage.get<SessionEventLogIndexV1>(
        sessionEventLogIndexKeyV1(sessionId),
      ),
      sessionId,
    );
    if (!index) {
      const legacy =
        (await this.storage.get<unknown[]>(LATEST_EVENTS_KEY)) ?? [];
      return legacy.map(decodeSessionEvent);
    }
    const events: SessionEvent[] = [];
    for (let page = 0; page < index.pageCount; page += 1) {
      const stored = requirePage(
        await this.storage.get<StoredSessionEventPageV1>(
          sessionEventLogPageKey(sessionId, page),
        ),
        sessionId,
        page,
      );
      if (stored.startSeq !== events.length) {
        throw new Error(
          `Session event pages for "${sessionId}" are not contiguous`,
        );
      }
      for (const entry of stored.entries) {
        events.push(await this.exactEvent(sessionId, entry));
      }
    }
    if (events.length !== index.eventCount) {
      throw new Error(
        `Session event index for "${sessionId}" has the wrong count`,
      );
    }
    for (const [seq, event] of events.entries()) {
      if (event.seq !== seq) {
        throw new Error(
          `Session event log for "${sessionId}" is not contiguous`,
        );
      }
    }
    return events;
  }

  async readRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
  ): Promise<SessionEvent[]> {
    if (
      !Number.isSafeInteger(startSeq) ||
      !Number.isSafeInteger(endSeq) ||
      startSeq < 0 ||
      endSeq < startSeq
    ) {
      throw new Error("Session event range is invalid");
    }
    return (await this.read(sessionId)).slice(startSeq, endSeq);
  }

  async readProjections(
    sessionId: string,
    startSeq = 0,
    endSeq = Number.MAX_SAFE_INTEGER,
  ): Promise<unknown[]> {
    const index = requireIndex(
      await this.storage.get<SessionEventLogIndexV1>(
        sessionEventLogIndexKeyV1(sessionId),
      ),
      sessionId,
    );
    if (!index) {
      const legacy = await this.read(sessionId);
      return Promise.all(
        legacy.slice(startSeq, endSeq).map(async (event) => {
          const serialized = JSON.stringify(event);
          if (
            event.type !== "model/request" &&
            encoder.encode(serialized).byteLength <=
              SESSION_EVENT_INLINE_BYTES_V1
          ) {
            return event;
          }
          const digest = await sha256(serialized);
          return cutProjection(event, serialized, digest);
        }),
      );
    }
    const projected: unknown[] = [];
    for (let page = 0; page < index.pageCount; page += 1) {
      const stored = requirePage(
        await this.storage.get<StoredSessionEventPageV1>(
          sessionEventLogPageKey(sessionId, page),
        ),
        sessionId,
        page,
      );
      for (const entry of stored.entries) {
        const seq =
          entry.storage === "inline" ? entry.event.seq : entry.projection.seq;
        if (seq >= startSeq && seq < endSeq) {
          projected.push(
            entry.storage === "inline" ? entry.event : entry.projection,
          );
        }
      }
    }
    return projected;
  }

  /** Reads the legacy value and rewrites it as pages when necessary. */
  async migrate(sessionId: string): Promise<SessionEvent[]> {
    const index = requireIndex(
      await this.storage.get<SessionEventLogIndexV1>(
        sessionEventLogIndexKeyV1(sessionId),
      ),
      sessionId,
    );
    if (index) return this.read(sessionId);
    const legacy = (await this.storage.get<unknown[]>(LATEST_EVENTS_KEY)) ?? [];
    const events = legacy.map(decodeSessionEvent);
    await this.rewrite(sessionId, events);
    return events;
  }

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    let index = requireIndex(
      await this.storage.get<SessionEventLogIndexV1>(
        sessionEventLogIndexKeyV1(sessionId),
      ),
      sessionId,
    );
    if (!index) {
      await this.migrate(sessionId);
      index = requireIndex(
        await this.storage.get<SessionEventLogIndexV1>(
          sessionEventLogIndexKeyV1(sessionId),
        ),
        sessionId,
      );
    }
    if (!index)
      throw new Error("Session event migration did not write an index");
    const decoded = events.map(decodeSessionEvent);
    for (const [offset, event] of decoded.entries()) {
      if (event.seq !== index.eventCount + offset) {
        throw new Error(
          "Bot session persistence received non-contiguous events",
        );
      }
    }
    const entries = await Promise.all(
      decoded.map((event) => this.storedEvent(sessionId, event)),
    );
    await this.appendStored(sessionId, index, entries);
  }

  async rewrite(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const previous = await this.read(sessionId);
    const decoded = events.map(decodeSessionEvent);
    for (const [seq, event] of decoded.entries()) {
      if (event.seq !== seq) {
        throw new Error(
          `Session event log for "${sessionId}" is not contiguous`,
        );
      }
    }
    await this.clearPaged(sessionId);
    const empty: SessionEventLogIndexV1 = {
      schemaVersion: 1,
      sessionId,
      eventCount: 0,
      pageCount: 0,
    };
    await this.storage.put(sessionEventLogIndexKeyV1(sessionId), empty);
    if (decoded.length > 0) {
      const entries = await Promise.all(
        decoded.map((event) => this.storedEvent(sessionId, event)),
      );
      await this.appendStored(sessionId, empty, entries);
    }
    await this.rebaseRunRanges(sessionId, previous, decoded);
    await this.storage.delete(LATEST_EVENTS_KEY);
  }

  async clearCurrent(sessionId: string): Promise<void> {
    await this.rewrite(sessionId, []);
  }

  private async storedEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<StoredSessionEventV1> {
    const serialized = JSON.stringify(event);
    const bytes = encoder.encode(serialized).byteLength;
    if (
      event.type !== "model/request" &&
      bytes <= SESSION_EVENT_INLINE_BYTES_V1
    ) {
      return { storage: "inline", event: structuredClone(event) };
    }
    const digest = await sha256(serialized);
    const chunks = payloadChunks(serialized);
    for (const [chunk, value] of chunks.entries()) {
      if (
        encoder.encode(value).byteLength > SESSION_EVENT_PAYLOAD_CHUNK_BYTES_V1
      ) {
        throw new Error("Session event payload chunk exceeds its byte budget");
      }
      await this.storage.put(
        sessionEventPayloadKey(sessionId, event.seq, chunk),
        value,
      );
    }
    return {
      storage: "cut",
      projection: await cutProjection(event, serialized, digest),
      payload: { chunks: chunks.length, bytes, sha256: digest },
    };
  }

  private async exactEvent(
    sessionId: string,
    entry: StoredSessionEventV1,
  ): Promise<SessionEvent> {
    if (entry.storage === "inline") return decodeSessionEvent(entry.event);
    const parts: string[] = [];
    for (let chunk = 0; chunk < entry.payload.chunks; chunk += 1) {
      const part = await this.storage.get<string>(
        sessionEventPayloadKey(sessionId, entry.projection.seq, chunk),
      );
      if (typeof part !== "string") {
        throw new Error(
          `Session event payload ${entry.projection.seq}:${chunk} is missing`,
        );
      }
      parts.push(part);
    }
    const serialized = parts.join("");
    if (
      encoder.encode(serialized).byteLength !== entry.payload.bytes ||
      (await sha256(serialized)) !== entry.payload.sha256
    ) {
      throw new Error(
        `Session event payload ${entry.projection.seq} is corrupt`,
      );
    }
    return decodeSessionEvent(JSON.parse(serialized));
  }

  private async appendStored(
    sessionId: string,
    index: SessionEventLogIndexV1,
    entries: readonly StoredSessionEventV1[],
  ): Promise<void> {
    let pageNumber = Math.max(0, index.pageCount - 1);
    let page =
      index.pageCount === 0
        ? {
            schemaVersion: 1 as const,
            sessionId,
            page: 0,
            startSeq: index.eventCount,
            entries: [] as StoredSessionEventV1[],
          }
        : requirePage(
            await this.storage.get<StoredSessionEventPageV1>(
              sessionEventLogPageKey(sessionId, pageNumber),
            ),
            sessionId,
            pageNumber,
          );
    let dirty = false;
    let pageCount = index.pageCount;
    for (const entry of entries) {
      const candidate: StoredSessionEventPageV1 = {
        ...page,
        entries: [...page.entries, entry],
      };
      if (utf8Bytes(candidate) <= SESSION_EVENT_PAGE_BYTES_V1) {
        page = candidate;
        dirty = true;
        if (pageCount === 0) pageCount = 1;
        continue;
      }
      if (page.entries.length === 0) {
        throw new Error("A Session event projection exceeds the page budget");
      }
      if (dirty) {
        await this.storage.put(
          sessionEventLogPageKey(sessionId, pageNumber),
          page,
        );
      }
      pageNumber += 1;
      pageCount = pageNumber + 1;
      const seq =
        entry.storage === "inline" ? entry.event.seq : entry.projection.seq;
      page = {
        schemaVersion: 1,
        sessionId,
        page: pageNumber,
        startSeq: seq,
        entries: [entry],
      };
      if (utf8Bytes(page) > SESSION_EVENT_PAGE_BYTES_V1) {
        throw new Error("A Session event projection exceeds the page budget");
      }
      dirty = true;
    }
    if (dirty) {
      await this.storage.put(
        sessionEventLogPageKey(sessionId, pageNumber),
        page,
      );
    }
    await this.storage.put(sessionEventLogIndexKeyV1(sessionId), {
      schemaVersion: 1,
      sessionId,
      eventCount: index.eventCount + entries.length,
      pageCount,
    } satisfies SessionEventLogIndexV1);
  }

  private async clearPaged(sessionId: string): Promise<void> {
    const index = requireIndex(
      await this.storage.get<SessionEventLogIndexV1>(
        sessionEventLogIndexKeyV1(sessionId),
      ),
      sessionId,
    );
    for (let page = 0; page < (index?.pageCount ?? 0); page += 1) {
      const stored = requirePage(
        await this.storage.get<StoredSessionEventPageV1>(
          sessionEventLogPageKey(sessionId, page),
        ),
        sessionId,
        page,
      );
      for (const entry of stored.entries) {
        if (entry.storage !== "cut") continue;
        for (let chunk = 0; chunk < entry.payload.chunks; chunk += 1) {
          await this.storage.delete(
            sessionEventPayloadKey(sessionId, entry.projection.seq, chunk),
          );
        }
      }
      await this.storage.delete(sessionEventLogPageKey(sessionId, page));
    }
    await this.storage.delete(sessionEventLogIndexKeyV1(sessionId));
  }

  /**
   * Keeps compact run references valid when structural repair inserts events
   * into the middle of a Session and resequences the suffix. Rewrites retain
   * original events in order (or remove only a trailing, restarting Turn), so
   * matching their canonical form without `seq` yields every old boundary's
   * new coordinate. Legacy runs still embedding `events` need no reference
   * update and migrate when they are next written.
   */
  private async rebaseRunRanges(
    sessionId: string,
    previous: readonly SessionEvent[],
    rewritten: readonly SessionEvent[],
  ): Promise<void> {
    if (previous.length === 0) return;
    const signature = (event: SessionEvent): string => {
      const { seq: _seq, ...stable } = event;
      return JSON.stringify(stable);
    };
    const previousSignatures = previous.map(signature);
    const boundaries = new Map<number, number>();
    let previousIndex = 0;
    for (
      let rewrittenIndex = 0;
      rewrittenIndex < rewritten.length && previousIndex < previous.length;
      rewrittenIndex += 1
    ) {
      if (
        signature(rewritten[rewrittenIndex]!) ===
        previousSignatures[previousIndex]
      ) {
        boundaries.set(previousIndex, rewrittenIndex);
        previousIndex += 1;
      }
    }
    // A recovery restart may deliberately drop only the old trailing Turn.
    // Every boundary in that removed suffix collapses onto the new end.
    for (
      let boundary = previousIndex;
      boundary <= previous.length;
      boundary += 1
    ) {
      boundaries.set(boundary, rewritten.length);
    }

    const runs = await this.storage.list<Record<string, unknown>>({
      prefix: RUN_PREFIX,
    });
    for (const [key, run] of runs) {
      if (run.sessionId !== sessionId || !isEventRange(run.eventRange))
        continue;
      const startSeq = boundaries.get(run.eventRange.startSeq);
      const endSeq = boundaries.get(run.eventRange.endSeq);
      if (startSeq === undefined || endSeq === undefined) {
        throw new Error(`run range in "${key}" cannot follow Session rewrite`);
      }
      await this.storage.put(key, {
        ...run,
        previousEventCount: startSeq,
        eventRange: { startSeq, endSeq },
      });
    }
  }
}

function isEventRange(
  value: unknown,
): value is { startSeq: number; endSeq: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(candidate.startSeq) &&
    Number.isSafeInteger(candidate.endSeq) &&
    (candidate.startSeq as number) >= 0 &&
    (candidate.endSeq as number) >= (candidate.startSeq as number)
  );
}
