// Narrow store over the Bot object's transaction. Pages, the turn index, and
// the head commit with the event batch that produced them; a replayed range
// does not write again.
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  advanceConversationHeadV1,
  planCursorAdvanceV1,
  projectSessionAppendV1,
  registerWorkingContextProjectorV1,
  requireConversationHeadV1,
  type WorkingContextStorageV1,
} from "@frockbot/core/durable";
import {
  emptyConversationHeadV1,
  isChunkedMessageRefV1,
  type ChunkedMessageRefV1,
  type ConversationHeadV1,
  type LlmMessage,
  type SessionEvent,
  type StoredContextMessageV1,
  type TurnContextIndexV1,
  type TurnTypeV1,
  type VoiceExcerptV1,
  type WorkingContextPageV1,
} from "@frockbot/core/contracts";
import {
  workingContextChunkKeyV1,
  workingContextHeadKeyV1,
  workingContextPageKeyV1,
  workingContextPagePrefixV1,
  workingContextTurnKeyV1,
  workingContextTurnPrefixV1,
  workingContextVoiceKeyV1,
} from "@frockbot/core/durable";
import { historyCharsV1, type CompactionStateV1 } from "./compaction.js";
import { CHAT_HISTORY_BUDGET_CHARS_V1, type ChatWindowV1 } from "./history.js";
import {
  chooseWorkingTurnsV1,
  turnOpeningMessagesV1,
  emptyVoiceExcerptV1,
  reduceWorkingContextAppendV1,
  renderWorkingContextV1,
  turnsTouchedV1,
  type TurnProjectionV1,
} from "./working-context.js";

/** One normalized-message page, kept under the event-log page ceiling. */
export const WORKING_CONTEXT_PAGE_BYTES_V1 = 64 * 1024;
export const WORKING_CONTEXT_CHUNK_BYTES_V1 = 32 * 1024;
const TURN_LIST_LIMIT_V1 = 16;

const encoder = new TextEncoder();

export class WorkingContextUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkingContextUnavailableError";
  }
}

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function chunkText(serialized: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < serialized.length) {
    let end = Math.min(serialized.length, offset + 8_000);
    while (
      end > offset &&
      encoder.encode(serialized.slice(offset, end)).byteLength >
        WORKING_CONTEXT_CHUNK_BYTES_V1
    ) {
      end -= 1;
    }
    if (end === offset) {
      throw new Error("working context message cannot be chunked");
    }
    chunks.push(serialized.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function storeMessages(
  storage: WorkingContextStorageV1,
  sessionId: string,
  turn: number,
  messages: readonly LlmMessage[],
): Promise<StoredContextMessageV1[]> {
  const stored: StoredContextMessageV1[] = [];
  for (const [index, message] of messages.entries()) {
    const serialized = JSON.stringify(message);
    if (
      encoder.encode(serialized).byteLength <= WORKING_CONTEXT_PAGE_BYTES_V1
    ) {
      stored.push(message);
      continue;
    }
    const digest = await sha256HexTextV1(serialized);
    const chunks = chunkText(serialized);
    for (const [chunk, value] of chunks.entries()) {
      await storage.put(
        workingContextChunkKeyV1(sessionId, turn, index, chunk),
        value,
      );
    }
    stored.push({
      storage: "chunked",
      bytes: encoder.encode(serialized).byteLength,
      sha256: digest,
      chunks: chunks.length,
    });
  }
  return stored;
}

async function writePages(
  storage: WorkingContextStorageV1,
  sessionId: string,
  turn: number,
  messages: readonly LlmMessage[],
  previousPageCount: number,
): Promise<number> {
  const stored = await storeMessages(storage, sessionId, turn, messages);
  const pages: WorkingContextPageV1[] = [];
  let current: StoredContextMessageV1[] = [];
  const flush = () => {
    if (current.length === 0 && pages.length > 0) return;
    pages.push({
      schemaVersion: 1,
      sessionId,
      turn,
      page: pages.length,
      messages: current,
    });
    current = [];
  };
  for (const message of stored) {
    const candidate = [...current, message];
    const page: WorkingContextPageV1 = {
      schemaVersion: 1,
      sessionId,
      turn,
      page: pages.length,
      messages: candidate,
    };
    if (current.length > 0 && bytes(page) > WORKING_CONTEXT_PAGE_BYTES_V1) {
      flush();
      current = [message];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0 || pages.length === 0) flush();
  const written =
    messages.length === 0
      ? []
      : pages.filter((page) => page.messages.length > 0);
  for (const page of written) {
    if (bytes(page) > WORKING_CONTEXT_PAGE_BYTES_V1) {
      throw new Error("working context page exceeds its byte budget");
    }
    await storage.put(workingContextPageKeyV1(sessionId, turn, page.page), {
      ...page,
      page: written.indexOf(page),
    });
  }
  for (let page = written.length; page < previousPageCount; page += 1) {
    await storage.delete(workingContextPageKeyV1(sessionId, turn, page));
  }
  return written.length;
}

async function readMessages(
  storage: WorkingContextStorageV1,
  sessionId: string,
  index: TurnContextIndexV1,
): Promise<LlmMessage[]> {
  const messages: LlmMessage[] = [];
  let messageIndex = 0;
  for (let page = 0; page < index.pageCount; page += 1) {
    const stored = await storage.get<WorkingContextPageV1>(
      workingContextPageKeyV1(sessionId, index.turn, page),
    );
    if (
      !stored ||
      stored.schemaVersion !== 1 ||
      stored.turn !== index.turn ||
      !Array.isArray(stored.messages)
    ) {
      throw new WorkingContextUnavailableError(
        `working context page ${index.turn}:${page} is missing`,
      );
    }
    for (const message of stored.messages) {
      if (isChunkedMessageRefV1(message)) {
        messages.push(
          await readChunked(
            storage,
            sessionId,
            index.turn,
            messageIndex,
            message,
          ),
        );
      } else {
        messages.push(message);
      }
      messageIndex += 1;
    }
  }
  return messages;
}

async function readChunked(
  storage: WorkingContextStorageV1,
  sessionId: string,
  turn: number,
  messageIndex: number,
  ref: ChunkedMessageRefV1,
): Promise<LlmMessage> {
  const parts: string[] = [];
  for (let chunk = 0; chunk < ref.chunks; chunk += 1) {
    const part = await storage.get<string>(
      workingContextChunkKeyV1(sessionId, turn, messageIndex, chunk),
    );
    if (typeof part !== "string") {
      throw new WorkingContextUnavailableError(
        `working context message ${turn}:${messageIndex} is missing a chunk`,
      );
    }
    parts.push(part);
  }
  const serialized = parts.join("");
  if (
    encoder.encode(serialized).byteLength !== ref.bytes ||
    (await sha256HexTextV1(serialized)) !== ref.sha256
  ) {
    throw new WorkingContextUnavailableError(
      `working context message ${turn}:${messageIndex} is corrupt`,
    );
  }
  return JSON.parse(serialized) as LlmMessage;
}

async function loadTurn(
  storage: WorkingContextStorageV1,
  sessionId: string,
  turn: number,
): Promise<TurnProjectionV1 | undefined> {
  const index = await storage.get<TurnContextIndexV1>(
    workingContextTurnKeyV1(sessionId, turn),
  );
  if (!index) return undefined;
  if (index.schemaVersion !== 1 || index.turn !== turn) {
    throw new WorkingContextUnavailableError(
      `working context turn ${turn} is corrupt`,
    );
  }
  return { index, messages: await readMessages(storage, sessionId, index) };
}

async function loadVoice(
  storage: WorkingContextStorageV1,
  sessionId: string,
): Promise<VoiceExcerptV1> {
  const voice = await storage.get<VoiceExcerptV1>(
    workingContextVoiceKeyV1(sessionId),
  );
  if (!voice) return emptyVoiceExcerptV1(sessionId);
  if (voice.schemaVersion !== 1 || voice.sessionId !== sessionId) {
    throw new WorkingContextUnavailableError("voice excerpt is corrupt");
  }
  return voice;
}

export async function applyWorkingContextAppendV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  events: readonly SessionEvent[],
  meta?: { runId?: string; expectedEpoch?: number },
): Promise<void> {
  const existing = requireConversationHeadV1(
    await storage.get(workingContextHeadKeyV1(sessionId)),
    sessionId,
  );
  const plan = planCursorAdvanceV1(
    existing,
    sessionId,
    events,
    meta?.expectedEpoch,
  );
  if (plan.kind === "replay") return;
  if (plan.kind === "reject") throw new Error(plan.reason);
  const head = existing
    ? { ...existing, status: "ready" as const }
    : emptyConversationHeadV1(sessionId);
  const loaded = new Map<number, TurnProjectionV1>();
  for (const turn of turnsTouchedV1(events)) {
    const projection = await loadTurn(storage, sessionId, turn);
    if (projection) loaded.set(turn, projection);
  }
  const voice = await loadVoice(storage, sessionId);
  const reduced = reduceWorkingContextAppendV1({
    head,
    turns: loaded,
    voice,
    events,
    ...(meta?.runId ? { runId: meta.runId } : {}),
  });
  let advanced = advanceConversationHeadV1(reduced.head, events);
  advanced = { ...advanced, status: "ready" };
  if (advanced.compaction && reduced.head.compaction) {
    advanced = {
      ...advanced,
      compaction: {
        ...advanced.compaction,
        sourceEpoch: advanced.epoch,
        sourceRevision: advanced.revision,
      },
    };
  }
  await storage.put(workingContextHeadKeyV1(sessionId), advanced);
  await storage.put(workingContextVoiceKeyV1(sessionId), reduced.voice);
  for (const turn of reduced.turns) {
    const pageCount = await writePages(
      storage,
      sessionId,
      turn.index.turn,
      turn.messages,
      turn.index.pageCount,
    );
    await storage.put(workingContextTurnKeyV1(sessionId, turn.index.turn), {
      ...turn.index,
      pageCount,
    });
  }
}

export async function replaceWorkingContextV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  events: readonly SessionEvent[],
): Promise<void> {
  const previous = requireConversationHeadV1(
    await storage.get(workingContextHeadKeyV1(sessionId)),
    sessionId,
  );
  await clearWorkingContextKeysV1(storage, sessionId);
  const head = emptyConversationHeadV1(sessionId);
  head.epoch = (previous?.epoch ?? 1) + 1;
  if (events.length === 0) {
    await storage.put(workingContextHeadKeyV1(sessionId), head);
    return;
  }
  // The replacement log is already in memory. Project it as one batch whose
  // sequences start at zero; this is not a startup read of stored pages.
  await applyReplacementV1(storage, head, events);
}

async function applyReplacementV1(
  storage: WorkingContextStorageV1,
  head: ConversationHeadV1,
  events: readonly SessionEvent[],
): Promise<void> {
  const sessionId = head.sessionId;
  const reduced = reduceWorkingContextAppendV1({
    head,
    turns: new Map(),
    voice: emptyVoiceExcerptV1(sessionId),
    events,
  });
  let advanced = advanceConversationHeadV1(reduced.head, events);
  advanced = { ...advanced, status: "ready", epoch: head.epoch };
  if (advanced.compaction) {
    advanced = {
      ...advanced,
      compaction: {
        ...advanced.compaction,
        sourceEpoch: advanced.epoch,
        sourceRevision: advanced.revision,
      },
    };
  }
  await storage.put(workingContextHeadKeyV1(sessionId), advanced);
  await storage.put(workingContextVoiceKeyV1(sessionId), reduced.voice);
  for (const turn of reduced.turns) {
    const pageCount = await writePages(
      storage,
      sessionId,
      turn.index.turn,
      turn.messages,
      0,
    );
    await storage.put(workingContextTurnKeyV1(sessionId, turn.index.turn), {
      ...turn.index,
      pageCount,
    });
  }
}

export async function truncateWorkingContextV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
  startSeq: number,
): Promise<void> {
  const head = requireConversationHeadV1(
    await storage.get(workingContextHeadKeyV1(sessionId)),
    sessionId,
  );
  if (!head || startSeq >= head.projectedThroughSeq) return;
  let end: string | undefined;
  for (;;) {
    const page = await storage.list<TurnContextIndexV1>({
      prefix: workingContextTurnPrefixV1(sessionId),
      reverse: true,
      limit: TURN_LIST_LIMIT_V1,
      ...(end ? { end } : {}),
    });
    if (page.size === 0) break;
    let stop = false;
    for (const [key, turn] of page) {
      end = key;
      if (turn.startSeq < startSeq && turn.endSeq <= startSeq) {
        stop = true;
        break;
      }
      if (turn.startSeq >= startSeq) {
        for (let pageNumber = 0; pageNumber < turn.pageCount; pageNumber += 1) {
          await storage.delete(
            workingContextPageKeyV1(sessionId, turn.turn, pageNumber),
          );
        }
        await storage.delete(key);
        if (turn.counted && head.chatTurnCount > 0) head.chatTurnCount -= 1;
        if (turn.messageBearing && head.messageBearingChatTurns > 0) {
          head.messageBearingChatTurns -= 1;
        }
      }
    }
    if (stop || page.size < TURN_LIST_LIMIT_V1) break;
  }
  const voice = await loadVoice(storage, sessionId);
  voice.lines = voice.lines.filter((line) => line.seq < startSeq);
  if (head.compaction && head.compaction.throughSeq > startSeq) {
    delete head.compaction;
  }
  const { openTurn: _open, ...rest } = head;
  await storage.put(workingContextHeadKeyV1(sessionId), {
    ...rest,
    projectedThroughSeq: startSeq,
    nextSeq: startSeq,
    revision: head.revision + 1,
    epoch: head.epoch + 1,
    status: "ready",
  });
  await storage.put(workingContextVoiceKeyV1(sessionId), voice);
}

async function clearWorkingContextKeysV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
): Promise<void> {
  const prefixes = [
    workingContextTurnPrefixV1(sessionId),
    workingContextPagePrefixV1(sessionId, 0).slice(
      0,
      workingContextPagePrefixV1(sessionId, 0).lastIndexOf(":"),
    ),
  ];
  // Page keys share `context:page:<session>:` — delete by that prefix.
  const pagePrefix = workingContextPageKeyV1(sessionId, 0, 0).replace(
    /:\d+:\d+$/,
    ":",
  );
  for (const prefix of [workingContextTurnPrefixV1(sessionId), pagePrefix]) {
    for (;;) {
      const page = await storage.list<unknown>({ prefix, limit: 64 });
      if (page.size === 0) break;
      for (const key of page.keys()) await storage.delete(key);
      if (page.size < 64) break;
    }
  }
  await storage.delete(workingContextHeadKeyV1(sessionId));
  await storage.delete(workingContextVoiceKeyV1(sessionId));
  void prefixes;
}

/**
 * Drops one session's derived context and records that requests must not be
 * assembled until it is projected again. The event log is left in place.
 * Ordinary startup does not call this.
 */
export async function clearWorkingContextV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
): Promise<void> {
  await clearWorkingContextKeysV1(storage, sessionId);
  await storage.put(workingContextHeadKeyV1(sessionId), {
    ...emptyConversationHeadV1(sessionId),
    status: "unavailable",
    unavailableReason: "working context was cleared",
  });
}

export interface StoredContextRequestV1 {
  sessionId: string;
  currentTurn: number;
  currentTurnType: TurnTypeV1 | "unspecified";
  currentMessages: readonly LlmMessage[];
  budget?: number;
  pointer?(input: { sessionId: string; chatTurns: number }): string;
}

function compactionStateFromHead(
  head: ConversationHeadV1 | undefined,
): CompactionStateV1 {
  const summary = head?.compaction;
  return {
    failures: head?.compactionFailures ?? 0,
    lastFailureThroughTurn: head?.lastFailureThroughTurn ?? 0,
    ...(head?.unsettledCompaction
      ? { unsettled: head.unsettledCompaction }
      : {}),
    ...(summary
      ? {
          compaction: {
            effectId: summary.effectId,
            fromTurn: summary.fromTurn,
            throughTurn: summary.throughTurn,
            summary: summary.summary,
            identifiers: summary.identifiers,
            provider: summary.provider,
            model: summary.model,
          },
        }
      : {}),
  };
}

function chatTurn(turnType: TurnTypeV1 | "unspecified"): boolean {
  return (
    turnType === "chat" || turnType === "agent" || turnType === "unspecified"
  );
}

/**
 * The chat window a Turn-end compaction measures.
 *
 * Prior Turns come from the projection. The Turn that just ended comes from
 * the caller, because its messages are already in hand and loading them again
 * would count them twice.
 */
export async function storedCompactionWindowV1(
  storage: WorkingContextStorageV1,
  input: {
    sessionId: string;
    currentTurn: number;
    currentMessages: readonly LlmMessage[];
  },
): Promise<ChatWindowV1> {
  let head: ConversationHeadV1 | undefined;
  try {
    head = requireConversationHeadV1(
      await storage.get(workingContextHeadKeyV1(input.sessionId)),
      input.sessionId,
    );
  } catch {
    head = undefined;
  }
  const state = compactionStateFromHead(head);
  const covered =
    state.compaction && state.compaction.throughTurn < input.currentTurn
      ? state.compaction.throughTurn
      : 0;
  const indexes: TurnContextIndexV1[] = [];
  if (head?.status === "ready") {
    let start: string | undefined;
    for (;;) {
      const page = await storage.list<TurnContextIndexV1>({
        prefix: workingContextTurnPrefixV1(input.sessionId),
        limit: TURN_LIST_LIMIT_V1,
        ...(start ? { start } : {}),
      });
      if (page.size === 0) break;
      const entries = [...page.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      for (const [, turn] of entries) indexes.push(turn);
      if (page.size < TURN_LIST_LIMIT_V1) break;
      start = `${entries[entries.length - 1]![0]}\0`;
    }
  }
  const messages: LlmMessage[] = [];
  const turns: number[] = [];
  for (const index of indexes) {
    if (index.turn >= input.currentTurn) continue;
    if (!chatTurn(index.turnType) || !index.messageBearing) continue;
    if (index.turn <= covered) continue;
    const loaded = await readMessages(storage, input.sessionId, index);
    for (const message of loaded) {
      messages.push(message);
      turns.push(index.turn);
    }
  }
  for (const message of input.currentMessages) {
    messages.push(message);
    turns.push(input.currentTurn);
  }
  const chatTurns = [
    ...new Set(
      [
        ...indexes
          .filter((index) => chatTurn(index.turnType))
          .map((index) => index.turn),
        input.currentTurn,
      ].sort((left, right) => left - right),
    ),
  ];
  return {
    messages,
    turns,
    chatTurns,
    state,
    ...(state.compaction && state.compaction.throughTurn < input.currentTurn
      ? { compaction: state.compaction }
      : {}),
  };
}

/**
 * Selects a request from turn metadata, then fetches only the chosen pages.
 *
 * A missing or corrupt projection is an error, not an empty prompt. The
 * archive is not read here.
 */
export async function selectStoredWorkingContextV1(
  storage: WorkingContextStorageV1,
  request: StoredContextRequestV1,
): Promise<LlmMessage[]> {
  let head: ConversationHeadV1 | undefined;
  try {
    head = requireConversationHeadV1(
      await storage.get(workingContextHeadKeyV1(request.sessionId)),
      request.sessionId,
    );
  } catch (error) {
    throw new WorkingContextUnavailableError(
      error instanceof Error ? error.message : "working context is corrupt",
    );
  }
  if (!head || head.status !== "ready") {
    if ((head?.projectedThroughSeq ?? 0) === 0 && request.currentMessages) {
      return renderWorkingContextV1({
        head: head ?? emptyConversationHeadV1(request.sessionId),
        kept: [],
        omitted: 0,
        currentTurn: request.currentTurn,
        currentTurnType: request.currentTurnType,
        currentMessages: request.currentMessages,
        sessionId: request.sessionId,
        ...(request.pointer ? { pointer: request.pointer } : {}),
      });
    }
    throw new WorkingContextUnavailableError(
      head?.unavailableReason ?? "working context is unavailable",
    );
  }
  const metas: TurnContextIndexV1[] = [];
  let end: string | undefined;
  const budget = request.budget ?? CHAT_HISTORY_BUDGET_CHARS_V1;
  for (;;) {
    const page = await storage.list<TurnContextIndexV1>({
      prefix: workingContextTurnPrefixV1(request.sessionId),
      reverse: true,
      limit: TURN_LIST_LIMIT_V1,
      ...(end ? { end } : {}),
    });
    if (page.size === 0) break;
    for (const [key, turn] of page) {
      end = key;
      if (turn.turn >= request.currentTurn) continue;
      metas.push(turn);
    }
    const choice = chooseWorkingTurnsV1({
      head,
      turns: metas,
      currentTurn: request.currentTurn,
      currentTurnType: request.currentTurnType,
      currentChars: historyCharsV1(request.currentMessages),
      openingChars: historyCharsV1(
        turnOpeningMessagesV1(request.currentMessages),
      ),
      budget,
    });
    const oldestLoaded = metas[metas.length - 1];
    const covered =
      head.compaction !== undefined &&
      oldestLoaded !== undefined &&
      oldestLoaded.turn <= head.compaction.throughTurn;
    const filled =
      choice.kept.length <
      metas.filter(
        (turn) =>
          turn.messageBearing &&
          turn.turn < request.currentTurn &&
          (head!.compaction === undefined ||
            turn.turn > head!.compaction.throughTurn),
      ).length;
    if (covered || filled || page.size < TURN_LIST_LIMIT_V1) {
      const kept = await Promise.all(
        choice.kept.map(async (turn) => {
          const index = metas.find((item) => item.turn === turn);
          if (!index) {
            throw new WorkingContextUnavailableError(
              `working context turn ${turn} was not indexed`,
            );
          }
          return {
            turn,
            messages: await readMessages(storage, request.sessionId, index),
          };
        }),
      );
      return renderWorkingContextV1({
        head,
        kept,
        omitted: choice.omitted,
        currentTurn: request.currentTurn,
        currentTurnType: request.currentTurnType,
        currentMessages: request.currentMessages,
        sessionId: request.sessionId,
        ...(request.pointer ? { pointer: request.pointer } : {}),
      });
    }
  }
  return renderWorkingContextV1({
    head,
    kept: [],
    omitted: 0,
    currentTurn: request.currentTurn,
    currentTurnType: request.currentTurnType,
    currentMessages: request.currentMessages,
    sessionId: request.sessionId,
    ...(request.pointer ? { pointer: request.pointer } : {}),
  });
}

export async function readVoiceExcerptV1(
  storage: WorkingContextStorageV1,
  sessionId: string,
): Promise<VoiceExcerptV1> {
  return loadVoice(storage, sessionId);
}

registerWorkingContextProjectorV1({
  append: (storage, sessionId, events, meta) =>
    applyWorkingContextAppendV1(storage, sessionId, events, meta),
  replace: (storage, sessionId, events) =>
    replaceWorkingContextV1(storage, sessionId, events),
  truncate: (storage, sessionId, startSeq) =>
    truncateWorkingContextV1(storage, sessionId, startSeq),
});

// Imported for its registration. Callers that only need the cursor writer
// must not import this module.
void projectSessionAppendV1;
