// Working-context projection and the history policy that reads it.
//
// The event log stays the archive. This module turns a committed batch into
// turn metadata and normalized messages, then selects a request from that
// metadata before any page is fetched. Costs for a Turn that is outside the
// newest verbatim-tool window are the pruned costs, so an older Turn can
// become eligible when a newer tool payload is pruned — the selector does not
// keep only the last N messages.
import {
  expandToolCallOccurrencesV1,
  emptyConversationHeadV1,
  emptyCommittedContextV1,
  visibleSendTextV1,
  type CommittedContextV1,
  type ConversationHeadV1,
  type LlmMessage,
  type SessionEvent,
  type TurnContextIndexV1,
  type TurnTypeV1,
  type VoiceExcerptLineV1,
  type VoiceExcerptV1,
} from "@frockbot/core/contracts";
import { VOICE_HISTORY_MAX_LIMIT_V1 } from "@frockbot/app/voice/history";
import {
  compactionMessageV1,
  historyCharsV1,
  PRUNED_TOOL_RESULT_V1,
  PRUNE_MIN_RESULT_CHARS_V1,
  pruneToolOutputsV1,
  TOOL_OUTPUT_KEEP_RECENT_TURNS_V1,
  type CompactionV1,
} from "./compaction.js";
import {
  automationParentPointerV1,
  CHAT_HISTORY_BUDGET_CHARS_V1,
  omittedHistoryNoticeV1,
} from "./history.js";

export interface TurnProjectionV1 {
  index: TurnContextIndexV1;
  messages: LlmMessage[];
}

export interface WorkingContextProjectionV1 {
  head: ConversationHeadV1;
  turns: TurnProjectionV1[];
  voice: VoiceExcerptV1;
}

function chatLike(turnType: TurnContextIndexV1["turnType"]): boolean {
  return (
    turnType === "chat" ||
    turnType === "agent" ||
    turnType === "unspecified"
  );
}

function blankTurn(
  sessionId: string,
  turn: number,
  startSeq: number,
): TurnProjectionV1 {
  return {
    messages: [],
    index: {
      schemaVersion: 1,
      sessionId,
      turn,
      turnType: "unspecified",
      startSeq,
      endSeq: startSeq,
      fullChars: 0,
      prunedChars: 0,
      messageBearing: false,
      chatOrdinal: 0,
      counted: false,
      pageCount: 0,
      occurrences: {},
    },
  };
}

/** Tool payloads this Turn would lose once it is outside the verbatim window. */
export function pruneTurnToolPayloadsV1(
  messages: readonly LlmMessage[],
): LlmMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    if (message.content.length <= PRUNE_MIN_RESULT_CHARS_V1) return message;
    const { attachments: _attachments, ...rest } = message;
    return { ...rest, content: PRUNED_TOOL_RESULT_V1 };
  });
}

function retouch(turn: TurnProjectionV1): void {
  turn.index.fullChars = historyCharsV1(turn.messages);
  turn.index.prunedChars = historyCharsV1(
    pruneTurnToolPayloadsV1(turn.messages),
  );
  turn.index.pageCount = turn.messages.length === 0 ? 0 : turn.index.pageCount;
}

function ensure(
  turns: Map<number, TurnProjectionV1>,
  sessionId: string,
  turn: number,
  seq: number,
): TurnProjectionV1 {
  const existing = turns.get(turn);
  if (existing) return existing;
  const created = blankTurn(sessionId, turn, seq);
  turns.set(turn, created);
  return created;
}

function countTurn(head: ConversationHeadV1, turn: TurnProjectionV1): void {
  if (turn.index.counted || !chatLike(turn.index.turnType)) return;
  turn.index.counted = true;
  head.chatTurnCount += 1;
}

function noteMessages(
  head: ConversationHeadV1,
  turn: TurnProjectionV1,
): void {
  if (!chatLike(turn.index.turnType) || turn.messages.length === 0) return;
  if (turn.index.messageBearing) return;
  head.messageBearingChatTurns += 1;
  turn.index.messageBearing = true;
  turn.index.chatOrdinal = head.messageBearingChatTurns;
}

function rememberOccurrence(
  turn: TurnProjectionV1,
  event: Extract<SessionEvent, { type: "assistant/message" }>,
): void {
  for (const occurrence of expandToolCallOccurrencesV1(
    event.turn,
    event.step,
    event.toolCalls,
  )) {
    turn.index.occurrences[occurrence.occurrenceId] = {
      callId: occurrence.call.id,
      name: occurrence.call.name,
      nested: occurrence.parentOccurrenceId !== undefined,
    };
  }
}

function pushVoice(
  voice: VoiceExcerptV1,
  line: VoiceExcerptLineV1,
): void {
  voice.lines.push(line);
  const extra = voice.lines.length - VOICE_HISTORY_MAX_LIMIT_V1;
  if (extra > 0) voice.lines.splice(0, extra);
}

/**
 * Folds one contiguous batch into the turns it touches.
 *
 * The caller loads those turns first. Events that are not prompt messages —
 * including `model/request` — advance the caller’s cursor and do not become
 * pages. Private model requests are not read back to build this projection.
 */
export function reduceWorkingContextAppendV1(input: {
  head: ConversationHeadV1;
  turns: ReadonlyMap<number, TurnProjectionV1>;
  voice: VoiceExcerptV1;
  events: readonly SessionEvent[];
  runId?: string;
}): WorkingContextProjectionV1 {
  const head: ConversationHeadV1 = {
    ...input.head,
    compaction: input.head.compaction
      ? { ...input.head.compaction }
      : undefined,
  };
  const turns = new Map<number, TurnProjectionV1>();
  for (const [turn, projection] of input.turns) {
    turns.set(turn, {
      index: {
        ...projection.index,
        occurrences: { ...projection.index.occurrences },
      },
      messages: projection.messages.map((message) => structuredClone(message)),
    });
  }
  const voice: VoiceExcerptV1 = {
    ...input.voice,
    lines: input.voice.lines.map((line) => ({ ...line })),
  };
  const dirty = new Set<number>();

  for (const event of input.events) {
    if (event.type === "turn/start") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      turn.index.startSeq = Math.min(turn.index.startSeq, event.seq);
      turn.index.endSeq = event.seq + 1;
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "turn/admission") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      turn.index.turnType = event.turnType;
      turn.index.endSeq = Math.max(turn.index.endSeq, event.seq + 1);
      countTurn(head, turn);
      noteMessages(head, turn);
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "turn/end") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      if (turn.index.turnType === "unspecified") {
        countTurn(head, turn);
        noteMessages(head, turn);
      }
      turn.index.endSeq = Math.max(turn.index.endSeq, event.seq + 1);
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "user/message") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      turn.messages.push({ role: "user", content: event.text });
      turn.index.endSeq = Math.max(turn.index.endSeq, event.seq + 1);
      noteMessages(head, turn);
      pushVoice(voice, {
        role: "user",
        text: event.text,
        turn: event.turn,
        seq: event.seq,
        at: event.timestamp,
        ...(input.runId ? { runId: input.runId } : {}),
      });
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "assistant/message") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      turn.messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: event.toolCalls,
        ...(event.providerState
          ? { providerState: structuredClone(event.providerState) }
          : {}),
      });
      rememberOccurrence(turn, event);
      turn.index.endSeq = Math.max(turn.index.endSeq, event.seq + 1);
      noteMessages(head, turn);
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "tool/result") {
      const turn = ensure(turns, head.sessionId, event.turn, event.seq);
      const occurrence = turn.index.occurrences[event.occurrenceId];
      turn.index.endSeq = Math.max(turn.index.endSeq, event.seq + 1);
      // A nested batch child has no provider tool call to answer. Any other
      // result is a message, including one whose assistant call used an
      // occurrence id the expander did not mint — the archive still said it.
      if (!occurrence?.nested) {
        turn.messages.push({
          role: "tool",
          callId: occurrence?.callId ?? event.occurrenceId,
          name: event.name,
          content: event.content,
          isError: event.isError,
          ...(event.attachments && event.attachments.length > 0
            ? { attachments: event.attachments.map((item) => ({ ...item })) }
            : {}),
        });
        noteMessages(head, turn);
      }
      dirty.add(event.turn);
      continue;
    }
    if (event.type === "send/to-user") {
      pushVoice(voice, {
        role: "assistant",
        text: visibleSendTextV1(event.payload),
        turn: event.turn,
        seq: event.seq,
        at: event.timestamp,
        to: "user",
        ...(input.runId ? { runId: input.runId } : {}),
      });
      continue;
    }
    if (event.type === "reply/to-caller") {
      pushVoice(voice, {
        role: "assistant",
        text: event.text,
        turn: event.turn,
        seq: event.seq,
        at: event.timestamp,
        to: event.caller,
        ...(input.runId ? { runId: input.runId } : {}),
      });
      continue;
    }
    if (event.type === "conversation/compaction-intent") {
      head.unsettledCompaction = {
        effectId: event.effectId,
        throughTurn: event.throughTurn,
      };
      continue;
    }
    if (event.type === "conversation/compaction-failed") {
      if (head.unsettledCompaction?.effectId === event.effectId) {
        delete head.unsettledCompaction;
      }
      head.compactionFailures += 1;
      head.lastFailureThroughTurn = event.throughTurn;
      continue;
    }
    if (event.type === "conversation/compacted") {
      if (event.throughTurn < event.fromTurn) {
        throw new Error("compaction covers an empty Turn range");
      }
      const covered = turns.get(event.throughTurn);
      if (
        head.compaction &&
        head.compaction.throughTurn > event.throughTurn
      ) {
        throw new Error("compaction is older than the committed summary");
      }
      if (head.unsettledCompaction?.effectId === event.effectId) {
        delete head.unsettledCompaction;
      }
      head.compactionFailures = 0;
      head.lastFailureThroughTurn = 0;
      head.compaction = {
        effectId: event.effectId,
        fromTurn: event.fromTurn,
        throughTurn: event.throughTurn,
        throughSeq: covered?.index.endSeq ?? event.seq,
        summary: event.summary,
        identifiers: [...event.identifiers],
        provider: event.provider,
        model: event.model,
        sourceEpoch: head.epoch,
        sourceRevision: head.revision,
        coveredMessageBearingTurns: covered?.index.messageBearing
          ? covered.index.chatOrdinal
          : head.messageBearingChatTurns,
      };
    }
  }

  for (const turn of dirty) retouch(turns.get(turn)!);
  return {
    head,
    turns: [...turns.values()].filter((turn) => dirty.has(turn.index.turn)),
    voice,
  };
}

/** Turns a batch reads or writes. Compaction also loads the Turn it covers. */
export function turnsTouchedV1(events: readonly SessionEvent[]): number[] {
  const turns = new Set<number>();
  for (const event of events) {
    if ("turn" in event && typeof (event as { turn?: unknown }).turn === "number") {
      turns.add((event as { turn: number }).turn);
    }
    if (event.type === "conversation/compacted") turns.add(event.throughTurn);
  }
  return [...turns];
}

export function emptyVoiceExcerptV1(sessionId: string): VoiceExcerptV1 {
  return { schemaVersion: 1, sessionId, lines: [] };
}

export interface WorkingTurnMetaV1 {
  turn: number;
  turnType: TurnContextIndexV1["turnType"];
  fullChars: number;
  prunedChars: number;
  messageBearing: boolean;
  messages?: readonly LlmMessage[];
}

/**
 * Which committed Turns fit, using metadata only.
 *
 * Walks newest first and stops at the first Turn that does not fit, matching
 * whole-Turn eviction. `verbatim` is the newest tool-output window of the
 * post-compaction chat, including Turns the budget then drops.
 */
export function chooseWorkingTurnsV1(input: {
  head: ConversationHeadV1;
  /** Newest first. */
  turns: readonly WorkingTurnMetaV1[];
  currentTurn: number;
  currentTurnType: TurnTypeV1 | "unspecified";
  currentChars: number;
  budget: number;
}): { kept: number[]; omitted: number } {
  const compaction =
    input.head.compaction &&
    input.head.compaction.throughTurn < input.currentTurn
      ? input.head.compaction
      : undefined;
  const summaryChars = compaction
    ? historyCharsV1([compactionMessageV1(compactionAsV1(compaction))])
    : 0;
  const budgetForTurns = Math.max(0, input.budget - summaryChars);
  if (!chatLike(input.currentTurnType)) {
    return { kept: [], omitted: 0 };
  }
  let verbatimLeft = TOOL_OUTPUT_KEEP_RECENT_TURNS_V1;
  if (input.currentChars > 0) verbatimLeft -= 1;
  let spent = input.currentChars;
  const kept: number[] = [];
  for (const turn of input.turns) {
    if (turn.turn >= input.currentTurn) continue;
    if (compaction && turn.turn <= compaction.throughTurn) break;
    if (!chatLike(turn.turnType) || !turn.messageBearing) continue;
    const cost = verbatimLeft > 0 ? turn.fullChars : turn.prunedChars;
    if (verbatimLeft > 0) verbatimLeft -= 1;
    if (spent + cost > budgetForTurns) break;
    kept.push(turn.turn);
    spent += cost;
  }
  const covered = compaction?.coveredMessageBearingTurns ?? 0;
  const currentBearing = input.currentChars > 0 ? 1 : 0;
  const uncovered = Math.max(
    0,
    input.head.messageBearingChatTurns - covered - currentBearing,
  );
  return { kept, omitted: Math.max(0, uncovered - kept.length) };
}

function compactionAsV1(
  compaction: NonNullable<ConversationHeadV1["compaction"]>,
): CompactionV1 {
  return {
    effectId: compaction.effectId,
    fromTurn: compaction.fromTurn,
    throughTurn: compaction.throughTurn,
    summary: compaction.summary,
    identifiers: compaction.identifiers,
    provider: compaction.provider,
    model: compaction.model,
  };
}

/**
 * Renders the request from Turns already chosen and loaded.
 *
 * Summary bytes are the committed summary. Pruning and the omission line run
 * on the selected Turns, not on a fixed tail of the archive.
 */
export function renderWorkingContextV1(input: {
  head: ConversationHeadV1;
  kept: readonly { turn: number; messages: readonly LlmMessage[] }[];
  omitted: number;
  currentTurn: number;
  currentTurnType: TurnTypeV1 | "unspecified";
  currentMessages: readonly LlmMessage[];
  sessionId: string;
  pointer?(input: { sessionId: string; chatTurns: number }): string;
}): LlmMessage[] {
  if (!chatLike(input.currentTurnType)) {
    const chatTurns = input.head.messageBearingChatTurns;
    const pointer =
      input.pointer ??
      ((value: { sessionId: string; chatTurns: number }) =>
        automationParentPointerV1(value));
    return [
      {
        role: "user",
        content: pointer({ sessionId: input.sessionId, chatTurns }),
      },
      ...input.currentMessages,
    ];
  }
  const ordered = [...input.kept].sort((left, right) => left.turn - right.turn);
  const messages: LlmMessage[] = [];
  const turnNumbers: number[] = [];
  for (const turn of ordered) {
    for (const message of turn.messages) {
      messages.push(message);
      turnNumbers.push(turn.turn);
    }
  }
  for (const message of input.currentMessages) {
    messages.push(message);
    turnNumbers.push(input.currentTurn);
  }
  const pruned = pruneToolOutputsV1(messages, turnNumbers);
  const summary = input.head.compaction;
  const preamble: LlmMessage[] = [];
  if (summary && summary.throughTurn < input.currentTurn) {
    preamble.push(compactionMessageV1(compactionAsV1(summary)));
  }
  if (input.omitted > 0) {
    preamble.push({
      role: "user",
      content: omittedHistoryNoticeV1(input.omitted),
    });
  }
  return [...preamble, ...pruned];
}

/**
 * Assembles a request from an in-memory journal.
 *
 * Used when the journal is the whole resident session (tests, and a Turn that
 * started from an empty log). A journal whose first sequence is not zero is
 * not a history: the caller must select from the projection.
 */
export function assembleJournalContextV1(input: {
  events: readonly SessionEvent[];
  sessionId: string;
  budget?: number;
  pointer?(input: { sessionId: string; chatTurns: number }): string;
  currentTurn: number;
  currentTurnType: TurnTypeV1 | "unspecified";
  currentMessages: readonly LlmMessage[];
}): LlmMessage[] {
  const head = emptyConversationHeadV1(input.sessionId);
  const reduced = reduceWorkingContextAppendV1({
    head,
    turns: new Map(),
    voice: emptyVoiceExcerptV1(input.sessionId),
    events: input.events,
  });
  const prior = reduced.turns
    .map((turn) => turn.index)
    .filter((turn) => turn.turn !== input.currentTurn)
    .sort((left, right) => right.turn - left.turn);
  const messages = new Map(
    reduced.turns.map((turn) => [turn.index.turn, turn.messages] as const),
  );
  const choice = chooseWorkingTurnsV1({
    head: reduced.head,
    turns: prior,
    currentTurn: input.currentTurn,
    currentTurnType: input.currentTurnType,
    currentChars: historyCharsV1(input.currentMessages),
    budget: input.budget ?? CHAT_HISTORY_BUDGET_CHARS_V1,
  });
  return renderWorkingContextV1({
    head: reduced.head,
    kept: choice.kept.map((turn) => ({
      turn,
      messages: messages.get(turn) ?? [],
    })),
    omitted: choice.omitted,
    currentTurn: input.currentTurn,
    currentTurnType: input.currentTurnType,
    currentMessages: input.currentMessages,
    sessionId: input.sessionId,
    ...(input.pointer ? { pointer: input.pointer } : {}),
  });
}

export function committedContextFromTurnsV1(
  head: ConversationHeadV1,
  turns: readonly { index: TurnContextIndexV1; messages: LlmMessage[] }[],
): CommittedContextV1 {
  const context = emptyCommittedContextV1();
  return {
    ...context,
    ...(head.compaction
      ? {
          summary: {
            effectId: head.compaction.effectId,
            fromTurn: head.compaction.fromTurn,
            throughTurn: head.compaction.throughTurn,
            throughSeq: head.compaction.throughSeq,
            summary: head.compaction.summary,
            identifiers: head.compaction.identifiers,
            provider: head.compaction.provider,
            model: head.compaction.model,
            sourceEpoch: head.compaction.sourceEpoch,
            sourceRevision: head.compaction.sourceRevision,
          },
        }
      : {}),
    turns: turns.map((turn) => ({
      turn: turn.index.turn,
      turnType: turn.index.turnType,
      startSeq: turn.index.startSeq,
      endSeq: turn.index.endSeq,
      messages: turn.messages,
      fullChars: turn.index.fullChars,
      prunedChars: turn.index.prunedChars,
      messageBearing: turn.index.messageBearing,
    })),
    omittedTurns: 0,
  };
}
