// Compaction: how a conversation keeps its beginning instead of forgetting it.
//
// One model request is bounded, and whole Turns are evicted oldest-first when
// it overflows. Two tiers sit in front of that eviction, and this module is
// both of them plus the decision of when to reach for either:
//
//  1. **Prune old tool outputs.** A deterministic assembly rule, no durable
//     write and no model call. A `tool/result` message older than the newest
//     few Turns keeps its `callId` and `name` and loses only its payload, so
//     the call/result pairing every provider validates survives while the
//     bytes that actually dominate a long conversation do not. The same rule
//     clears the Turn being assembled's own older results once that Turn
//     alone grows past a bound, so a long tool loop cannot outgrow a request.
//  2. **Summarise the oldest Turns.** One `conversation/compacted` event on
//     the durable log, computed once and replayed thereafter. It is *not*
//     recomputed per request: that was the mistake the design this copies was
//     reverted for, and an event log is exactly the substrate that fixes it.
//
// Everything here is a pure function over the session log. The Turn-end hook
// in `agent.ts` is what runs the summariser and appends the events; this
// module decides what it should do and how the result is read back.
import {
  COMPACTION_FAILURE_REASON_MAX_LENGTH,
  COMPACTION_IDENTIFIERS_MAX,
  COMPACTION_IDENTIFIER_MAX_LENGTH,
  COMPACTION_SUMMARY_MAX_LENGTH,
  type LlmMessage,
  type ModelBindingSnapshot,
  decodeSessionEvent,
  type Session,
  type SessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";

/**
 * The share of the history budget above which a compaction is due.
 *
 * Below 1 on purpose: compaction exists to stop whole-Turn eviction being
 * reached, so it has to land before the budget is actually spent. Evaluated at
 * Turn end and never before a model call, so this threshold costs a person no
 * latency — the Turn they were waiting on is already over when it is read.
 */
export const COMPACTION_TRIGGER_RATIO_V1 = 0.7;

/**
 * Turns never covered by a compaction. The conversation the User is actually
 * having stays verbatim; only its history is compressed.
 */
export const COMPACTION_KEEP_RECENT_TURNS_V1 = 4;

/** Turns whose tool results keep their payload. Fewer than are kept verbatim. */
export const TOOL_OUTPUT_KEEP_RECENT_TURNS_V1 = 3;

/** What stands in for an elided tool payload. */
export const PRUNED_TOOL_RESULT_V1 = "[pruned]";

/** Longest a pruned tool result may be before it is worth pruning at all. */
export const PRUNE_MIN_RESULT_CHARS_V1 = 200;

/**
 * Size of the Turn being assembled above which its older tool results are
 * cleared. The current Turn is carried whole by the history budget, so this is
 * the only bound on it; a tool loop past it would otherwise grow the request
 * until the provider refuses it.
 */
export const TURN_TOOL_CLEAR_TRIGGER_CHARS_V1 = 100_000;

/**
 * What one clearing brings the Turn back down to. Well below the trigger, so
 * clearings come in batches: each one breaks the prompt cache once, and the
 * steps after it hit the cache again until the Turn next crosses the trigger.
 */
export const TURN_TOOL_CLEAR_TARGET_CHARS_V1 = 50_000;

/**
 * The Turn being assembled, with its oldest tool results cleared once it grows
 * past {@link TURN_TOOL_CLEAR_TRIGGER_CHARS_V1}.
 *
 * Replayed over the Turn in order, so the answer for a prefix never depends on
 * what came after it: a result cleared at one step stays cleared at every
 * later step, and nothing moves between clearings. Results the model has not
 * read yet — everything after its newest message, several at once when one
 * step made parallel calls — are never cleared. Calls and their inputs stay,
 * so the model can see what it asked for and ask again.
 */
export function clearTurnToolResultsV1(
  messages: readonly LlmMessage[],
): LlmMessage[] {
  const out: LlmMessage[] = [];
  let total = 0;
  let next = 0;
  let unread = 0;
  for (const message of messages) {
    out.push(message);
    total += historyCharsV1([message]);
    if (message.role === "assistant") unread = out.length;
    if (total <= TURN_TOOL_CLEAR_TRIGGER_CHARS_V1) continue;
    while (total > TURN_TOOL_CLEAR_TARGET_CHARS_V1 && next < unread) {
      const candidate = out[next]!;
      next += 1;
      if (candidate.role !== "tool") continue;
      if (candidate.content.length <= PRUNE_MIN_RESULT_CHARS_V1) continue;
      const { attachments: _attachments, ...rest } = candidate;
      const cleared = { ...rest, content: PRUNED_TOOL_RESULT_V1 };
      total += historyCharsV1([cleared]) - historyCharsV1([candidate]);
      out[next - 1] = cleared;
    }
  }
  return out;
}

/**
 * Most transcript one summariser call reads, in UTF-8 bytes once
 * JSON-encoded — the measure the gateway's prepaid bound applies. A backlog
 * larger than this is summarised oldest first, one bounded call at a time,
 * each folding in the summary before it.
 */
export const COMPACTION_INPUT_MAX_BYTES_V1 = 80_000;

/** Longest a tool result may be in a summariser's transcript. */
export const COMPACTION_TOOL_RESULT_MAX_CHARS_V1 = 2_000;

/**
 * What becomes of one message being summarised: its gist in the summary,
 * its exact words carried forward, or nothing at all.
 */
export type CompactionChoiceV1 = "summarise" | "keep" | "drop";

/** One message a chooser is asked about. */
export interface CompactionItemV1 {
  role: "user" | "tool";
  /** The tool, for a tool result. */
  tool?: string;
  text: string;
}

/**
 * Chooses for each item, in order, or `undefined` when it cannot say, and
 * then every message is summarised as before.
 */
export type CompactionChooserV1 = (
  items: readonly CompactionItemV1[],
  signal: AbortSignal,
) => Promise<readonly CompactionChoiceV1[] | undefined>;

/** Shorter than this, a message is summarised without asking. */
export const COMPACTION_CHOICE_MIN_CHARS_V1 = 120;

/** The most messages one slice asks about. */
export const COMPACTION_CHOICE_ITEMS_MAX_V1 = 40;

/** The most characters carried forward word for word, across a slice. */
export const COMPACTION_KEEP_MAX_CHARS_V1 = 4_000;

/** The most characters of one message carried forward word for word. */
export const COMPACTION_KEEP_ITEM_MAX_CHARS_V1 = 1_500;

/** Most slices one detached compaction summarises before it stops. */
export const COMPACTION_MAX_SLICES_PER_RUN_V1 = 8;

/** Time one summariser call is allowed. */
export const COMPACTION_DEADLINE_MS_V1 = 60_000;

/** Most Turn ends a retry ever waits after a failure. */
export const COMPACTION_MAX_BACKOFF_TURNS_V1 = 8;

/** One completed compaction, read back off the log. */
export interface CompactionV1 {
  effectId: string;
  fromTurn: number;
  throughTurn: number;
  summary: string;
  identifiers: readonly string[];
  provider: string;
  model: string;
}

/**
 * What the log says about compaction for this conversation.
 *
 * Everything the Turn-end hook needs to decide, derived rather than stored:
 * the newest completed compaction, an intent a restart left unsettled, and the
 * consecutive failures that space the next attempt.
 */
export interface CompactionStateV1 {
  compaction?: CompactionV1;
  /** An intent with neither outcome. A restart interrupted it. */
  unsettled?: { effectId: string; throughTurn: number };
  /** Consecutive failures since the last completed compaction. */
  failures: number;
  /** The Turn the newest failure was recorded in, for backoff. */
  lastFailureTurn: number;
}

export function compactionStateV1(
  events: readonly SessionEvent[],
): CompactionStateV1 {
  let compaction: CompactionV1 | undefined;
  let unsettled: { effectId: string; throughTurn: number } | undefined;
  let failures = 0;
  let lastFailureTurn = 0;
  let latestTurn = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      latestTurn = Math.max(latestTurn, event.turn);
      continue;
    }
    if (event.type === "conversation/compaction-intent") {
      unsettled = { effectId: event.effectId, throughTurn: event.throughTurn };
      continue;
    }
    if (event.type === "conversation/compacted") {
      if (unsettled?.effectId === event.effectId) unsettled = undefined;
      // A prefix supersedes every shorter prefix, so the newest wins outright.
      if (!compaction || event.throughTurn >= compaction.throughTurn) {
        compaction = {
          effectId: event.effectId,
          fromTurn: event.fromTurn,
          throughTurn: event.throughTurn,
          summary: event.summary,
          identifiers: event.identifiers,
          provider: event.provider,
          model: event.model,
        };
      }
      failures = 0;
      lastFailureTurn = 0;
      continue;
    }
    if (event.type === "conversation/compaction-failed") {
      if (unsettled?.effectId === event.effectId) unsettled = undefined;
      failures += 1;
      lastFailureTurn = latestTurn;
    }
  }
  return {
    ...(compaction ? { compaction } : {}),
    ...(unsettled ? { unsettled } : {}),
    failures,
    lastFailureTurn,
  };
}

/** The message a compaction contributes, first in the assembled window. */
export function compactionMessageV1(compaction: CompactionV1): LlmMessage {
  const identifiers =
    compaction.identifiers.length > 0
      ? `\n\nIdentifiers that appeared in those Turns, exactly as written: ${compaction.identifiers.join(", ")}`
      : "";
  return {
    role: "user",
    content: [
      `Turns ${compaction.fromTurn} to ${compaction.throughTurn} of this conversation are not included verbatim. This is their summary, and it is the only record of them in this request. Treat it as history you remember, not as something the user just said.`,
      "",
      compaction.summary,
      identifiers,
    ]
      .join("\n")
      .trimEnd(),
  };
}

/**
 * Replaces the payload of tool results older than the newest `keepTurns`.
 *
 * The message survives with its `callId` and `name`, because a tool result
 * whose call has been dropped is a malformed request to every provider — the
 * same constraint whole-Turn eviction solves by keeping both. Small results
 * are left alone: pruning one costs a round number of characters and buys
 * nothing.
 */
export function pruneToolOutputsV1(
  messages: readonly LlmMessage[],
  turns: readonly number[],
  keepTurns = TOOL_OUTPUT_KEEP_RECENT_TURNS_V1,
): LlmMessage[] {
  const distinct = [...new Set(turns)].sort((left, right) => right - left);
  const verbatim = new Set(distinct.slice(0, Math.max(0, keepTurns)));
  return messages.map((message, index) => {
    if (message.role !== "tool") return message;
    if (verbatim.has(turns[index]!)) return message;
    if (message.content.length <= PRUNE_MIN_RESULT_CHARS_V1) return message;
    const { attachments: _attachments, ...rest } = message;
    return { ...rest, content: PRUNED_TOOL_RESULT_V1 };
  });
}

/** The character measure, over whatever window it is given. */
export function historyCharsV1(messages: readonly LlmMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + JSON.stringify(message).length,
    0,
  );
}

/** What one Turn-end evaluation concluded. */
export interface CompactionAssessmentV1 {
  /** The pruned window's size, in characters. */
  chars: number;
  /** The threshold it was compared against. */
  threshold: number;
  /** The last Turn a new compaction would cover, when one is due. */
  throughTurn?: number;
  /** The first Turn it would cover — after any compaction already recorded. */
  fromTurn?: number;
  /** Why no compaction is due, when none is. */
  skipped?:
    | "under-threshold"
    | "nothing-new-to-cover"
    | "backing-off"
    | "not-a-conversation";
}

/**
 * Whether this conversation should be compacted, and over what range.
 *
 * `chatTurns` is every chat Turn on the log in order, and `messages`/`turns`
 * the chat-only window the next request would carry — already narrowed by any
 * compaction already recorded, so a conversation that has been compacted once
 * is measured on what it actually costs now.
 */
export function assessCompactionV1(input: {
  messages: readonly LlmMessage[];
  turns: readonly number[];
  chatTurns: readonly number[];
  state: CompactionStateV1;
  budget: number;
  /** The Turn that just ended, which spaces a retry after a failure. */
  currentTurn: number;
}): CompactionAssessmentV1 {
  const pruned = pruneToolOutputsV1(input.messages, input.turns);
  const chars = historyCharsV1(pruned);
  const threshold = Math.floor(input.budget * COMPACTION_TRIGGER_RATIO_V1);
  const base = { chars, threshold };
  if (chars <= threshold) return { ...base, skipped: "under-threshold" };
  const covered = input.state.compaction?.throughTurn ?? 0;
  const eligible = input.chatTurns.filter((turn) => turn > covered);
  const throughTurn = eligible
    .slice(0, Math.max(0, eligible.length - COMPACTION_KEEP_RECENT_TURNS_V1))
    .at(-1);
  if (throughTurn === undefined) {
    return { ...base, skipped: "nothing-new-to-cover" };
  }
  if (input.state.failures > 0) {
    const wait = Math.min(
      2 ** (input.state.failures - 1),
      COMPACTION_MAX_BACKOFF_TURNS_V1,
    );
    if (input.currentTurn - input.state.lastFailureTurn < wait) {
      return { ...base, skipped: "backing-off" };
    }
  }
  return {
    ...base,
    throughTurn,
    fromTurn: input.state.compaction ? input.state.compaction.fromTurn : 1,
  };
}

/**
 * The summariser's instructions.
 *
 * The identifier rule is the one artifact worth carrying over verbatim from
 * the design this replaces, and FrockBot's stakes are higher than a chat app's:
 * a paraphrased Package id, Plugin id, Session id or Workspace path becomes a
 * later tool call with a plausible-looking wrong argument. Asking the model to
 * *list* what it saw is a far stronger constraint than asking it not to mangle
 * ids in passing, and the list is what the event stores.
 */
export const COMPACTION_SYSTEM_PROMPT_V1 = [
  "You are compressing the earlier part of a conversation so it can be carried forward in a smaller prompt.",
  "",
  "CRITICAL: You MUST preserve ALL opaque identifiers exactly as they appear. That includes UUIDs, hashes, full URLs with their query parameters, file and Workspace paths, Package ids, Plugin ids, Bot ids, Session ids, tool call ids, model names and version strings. Do NOT paraphrase, abbreviate, or generalise an identifier. Copy it exactly.",
  "",
  "Answer in Markdown with exactly these four headings, in this order:",
  "## Summary — the gist, as prose.",
  "## Decisions — one bullet per decision and its reason. Keep only the latest where one superseded another.",
  "## Open items — one bullet per piece of pending work.",
  "## Identifiers mentioned — one bullet per opaque identifier, copied exactly.",
  'Write "- none" under a heading with nothing to list.',
  "",
  'When the transcript marks a passage "(keep word for word)", add a fifth heading after those four, ## Kept word for word, and copy each such passage under it exactly, one bullet each. Leave the heading out when nothing is marked.',
  "",
  "Leave out pleasantries, repetition, and superseded detail. Do not invent anything that is not in the transcript. Do not address the user.",
].join("\n");

/**
 * The transcript one summariser call is given, flattened to plain text. A
 * message chosen to keep is marked for the summary to carry word for word;
 * a tool result chosen to drop is named and left out.
 */
export function compactionTranscriptV1(
  messages: readonly LlmMessage[],
  choices?: ReadonlyMap<LlmMessage, CompactionChoiceV1>,
): string {
  return messages
    .map((message) => {
      const choice = choices?.get(message);
      if (message.role === "user") {
        return choice === "keep"
          ? `USER (keep word for word): ${message.content}`
          : `USER: ${message.content}`;
      }
      if (message.role === "tool") {
        const error = message.isError ? " (error)" : "";
        if (choice === "drop") {
          return `[tool-result ${message.name}${error}: omitted, nothing in it matters later]`;
        }
        if (choice === "keep") {
          return `[tool-result ${message.name}${error} (keep word for word): ${message.content}]`;
        }
        const content =
          message.content.length > COMPACTION_TOOL_RESULT_MAX_CHARS_V1
            ? `${message.content.slice(0, COMPACTION_TOOL_RESULT_MAX_CHARS_V1)} …[truncated]`
            : message.content;
        return `[tool-result ${message.name}${error}: ${content}]`;
      }
      const calls = message.toolCalls
        .map(
          (call) => `[tool-call ${call.name}(${JSON.stringify(call.input)})]`,
        )
        .join(" ");
      return `ASSISTANT: ${message.content}${calls ? ` ${calls}` : ""}`;
    })
    .join("\n");
}

/** A text's size as a request body carries it: UTF-8, JSON-escaped. */
export function compactionInputBytesV1(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

/** The longest beginning of `text` within `maxBytes`. */
function boundedPrefixV1(text: string, maxBytes: number): string {
  if (compactionInputBytesV1(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (compactionInputBytesV1(text.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, low)} …[truncated]`;
}

/** The one user message a summariser request carries. */
export function compactionRequestMessagesV1(input: {
  messages: readonly LlmMessage[];
  previous?: CompactionV1;
  choices?: ReadonlyMap<LlmMessage, CompactionChoiceV1>;
}): LlmMessage[] {
  const preamble = input.previous
    ? [
        `The conversation was already summarised through Turn ${input.previous.throughTurn}. That summary follows, then the Turns after it. Produce ONE summary covering both: fold the old summary in rather than repeating it beside the new material.`,
        "",
        "--- summary so far ---",
        input.previous.summary,
        "--- end summary so far ---",
        "",
      ].join("\n")
    : "";
  const transcript = compactionTranscriptV1(input.messages, input.choices);
  // A single Turn can outgrow the cap on its own; its beginning is kept.
  const bounded = boundedPrefixV1(transcript, COMPACTION_INPUT_MAX_BYTES_V1);
  return [
    {
      role: "user",
      content: `${preamble}--- transcript to summarise ---\n${bounded}\n--- end transcript ---`,
    },
  ];
}

/** A summary the log will accept, or `undefined` when there is nothing usable. */
export interface ParsedCompactionSummaryV1 {
  summary: string;
  identifiers: string[];
}

/**
 * Reads the summariser's answer back.
 *
 * The prose is kept whole and bounded; the identifier list is lifted out of
 * its heading so a test — and the audit view — can see exactly what the model
 * claimed to have preserved. A model that ignored the headings still produces
 * a usable summary with an empty identifier list, which is honest: it says
 * nothing was verified rather than pretending something was.
 */
export function parseCompactionSummaryV1(
  text: string,
): ParsedCompactionSummaryV1 | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const summary = trimmed.slice(0, COMPACTION_SUMMARY_MAX_LENGTH);
  const heading = summary.search(/^##\s*Identifiers mentioned\s*$/im);
  const identifiers: string[] = [];
  if (heading >= 0) {
    const body = summary.slice(heading).split("\n").slice(1);
    for (const line of body) {
      if (/^##\s/.test(line)) break;
      const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const value = match[1]!;
      if (value.toLowerCase() === "none") continue;
      if (value.length > COMPACTION_IDENTIFIER_MAX_LENGTH) continue;
      if (identifiers.length >= COMPACTION_IDENTIFIERS_MAX) break;
      if (!identifiers.includes(value)) identifiers.push(value);
    }
  }
  return { summary, identifiers };
}

/** The model, and the Connection authority, one summariser call runs on. */
export interface CompactionModelV1 {
  provider: string;
  model: string;
  modelBinding?: ModelBindingSnapshot;
}

/** The model one summariser call runs on, read back off the log. */
export function compactionModelV1(
  events: readonly SessionEvent[],
): CompactionModelV1 | undefined {
  const request = events.findLast((event) => event.type === "model/request");
  if (request?.type !== "model/request") return undefined;
  return {
    provider: request.request.provider,
    model: request.request.model,
    // The Connection authority the Turn ran under travels with it: a provider
    // refuses a request whose binding does not name the Connection generation
    // it holds, and rightly so — a summariser is not a way around that.
    ...(request.request.modelBinding
      ? { modelBinding: request.request.modelBinding }
      : {}),
  };
}

/** What one Turn-end evaluation actually did. */
export type CompactionOutcomeV1 =
  | { kind: "skipped"; assessment: CompactionAssessmentV1 }
  | { kind: "compacted"; throughTurn: number; fromTurn: number }
  | { kind: "failed"; throughTurn: number; reason: string }
  /** A Turn took the log before anything was begun. */
  | { kind: "yielded" }
  /** The outcome arrived while a Turn held the log; the next Turn end writes it. */
  | { kind: "parked"; throughTurn: number };

/** A summariser's outcome, waiting for the log. */
export type ParkedCompactionV1 = Extract<
  SessionEventInput,
  { type: "conversation/compacted" | "conversation/compaction-failed" }
>;

/** Where a parked outcome waits. Durable in a Bot, in memory in a test. */
export interface ParkedCompactionStoreV1 {
  read(): Promise<ParkedCompactionV1 | undefined>;
  write(outcome: ParkedCompactionV1): Promise<void>;
  clear(): Promise<void>;
}

/** The session log as one compaction run may use it. */
export interface CompactionLogV1 {
  /** The Turn's own journal, for the model a summary falls back to. */
  journal: readonly SessionEvent[];
  /** Appends and flushes one event; `false` when a Turn holds the log. */
  append(event: SessionEventInput): Promise<boolean>;
  /** Keeps an outcome that could not be written. */
  park(outcome: ParkedCompactionV1): Promise<void>;
}

/** A log this run alone writes, so every append lands. */
export function sessionCompactionLogV1(
  session: Session,
  parked?: ParkedCompactionStoreV1,
): CompactionLogV1 {
  return {
    journal: session.activeRunJournal,
    append: async (event) => {
      session.append(event);
      await session.flush();
      return true;
    },
    park: async (outcome) => {
      if (!parked) throw new Error("this log has nowhere to park an outcome");
      await parked.write(outcome);
    },
  };
}

/**
 * Writes an outcome parked while a Turn held the log, before anything else
 * reads the log's compaction state. One whose intent is no longer the open one
 * — already written before a crash cleared the store, or superseded — is
 * dropped, so this is safe to repeat.
 */
export async function applyParkedCompactionV1(input: {
  log: CompactionLogV1;
  parked: ParkedCompactionStoreV1;
  state: CompactionStateV1;
}): Promise<"none" | "applied" | "dropped" | "yielded"> {
  const outcome = await input.parked.read();
  if (!outcome) return "none";
  const current = input.state.compaction?.throughTurn ?? 0;
  if (
    input.state.unsettled?.effectId !== outcome.effectId ||
    (outcome.type === "conversation/compacted" && outcome.throughTurn < current)
  ) {
    await input.parked.clear();
    return "dropped";
  }
  if (!(await input.log.append(outcome))) return "yielded";
  await input.parked.clear();
  return "applied";
}

/** The storage key a conversation's parked outcome waits under. */
export function parkedCompactionKeyV1(sessionId: string): string {
  return `compaction-parked:${sessionId}`;
}

/**
 * A parked outcome in the Bot's own storage, so a summary that landed while a
 * Turn ran survives the object being evicted before the next Turn ends.
 */
export function storedParkedCompactionV1(
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  },
  sessionId: string,
): ParkedCompactionStoreV1 {
  const key = parkedCompactionKeyV1(sessionId);
  return {
    read: async () => {
      const value = await storage.get(key);
      if (value === undefined) return undefined;
      try {
        // Decoded as the event it will become, so nothing unreadable is
        // ever appended to the log.
        const event = decodeSessionEvent({
          ...(value as object),
          seq: 0,
          timestamp: new Date(0).toISOString(),
        });
        if (
          event.type === "conversation/compacted" ||
          event.type === "conversation/compaction-failed"
        ) {
          return value as ParkedCompactionV1;
        }
      } catch {
        // Unreadable: dropped below.
      }
      await storage.delete(key);
      return undefined;
    },
    write: (outcome) => storage.put(key, outcome),
    clear: async () => {
      await storage.delete(key);
    },
  };
}

export interface CompactionRunnerV1 {
  /** Where the run's events are written, while it may write them. */
  log: CompactionLogV1;
  /** The chat-only window the next request would carry, already narrowed. */
  window: {
    messages: readonly LlmMessage[];
    turns: readonly number[];
    chatTurns: readonly number[];
    state: CompactionStateV1;
  };
  budget: number;
  currentTurn: number;
  /**
   * The model the summary runs on. Absent, it runs on the model the Turn's
   * own last request used.
   */
  model?: CompactionModelV1;
  newEffectId(): string;
  /** Chooses which messages survive word for word. Absent, all are summarised. */
  choose?: CompactionChooserV1;
  /**
   * One bounded summariser call on the summary model.
   *
   * `effectId` is the id the intent above was recorded under, and it is the
   * id the call must be dispatched under: it is what makes a summariser call
   * as at-most-once as any other model effect, and what lets the host find
   * the durable intent when the dispatch reaches it.
   */
  summarise(
    request: CompactionModelV1 & {
      effectId: string;
      system: string;
      messages: LlmMessage[];
      signal: AbortSignal;
    },
  ): Promise<string>;
  deadlineMs?: number;
}

/**
 * One compaction evaluation, run after a Turn has ended.
 *
 * Everything durable it does is bounded by the range it covers, so a restart
 * cannot double-write: an unsettled intent left by a previous attempt is
 * settled as a failure first, the range is refused if a `conversation/compacted`
 * already covers it, and the Durable Object is single-threaded between the
 * check and the append. A Turn admitted meanwhile holds the log, so the outcome
 * is parked for the next Turn end rather than written beside it. Failure is
 * never fatal — the request that follows is exactly the request that would have
 * been assembled without it.
 */
export async function runCompactionV1(
  input: CompactionRunnerV1,
): Promise<CompactionOutcomeV1> {
  const log = input.log;
  const state = input.window.state;
  if (state.unsettled) {
    // A restart interrupted an attempt. Its outcome is unknowable, so it is
    // settled as a failure — and then tried again now, because an
    // interruption says nothing about whether the next attempt will work.
    // Deploys interrupt often enough that waiting out a backoff for each one
    // left conversations uncompacted for days.
    const settled = await log.append({
      type: "conversation/compaction-failed",
      effectId: state.unsettled.effectId,
      throughTurn: state.unsettled.throughTurn,
      reason: "Interrupted before a summary was recorded.",
    });
    if (!settled) return { kind: "yielded" };
  }
  const assessment = assessCompactionV1({
    messages: input.window.messages,
    turns: input.window.turns,
    chatTurns: input.window.chatTurns,
    state,
    budget: input.budget,
    currentTurn: input.currentTurn,
  });
  if (
    assessment.throughTurn === undefined ||
    assessment.fromTurn === undefined
  ) {
    return { kind: "skipped", assessment };
  }
  const { fromTurn } = assessment;
  const binding = input.model ?? compactionModelV1(log.journal);
  if (!binding) return { kind: "skipped", assessment };
  const { throughTurn, covered } = compactionSliceV1({
    messages: input.window.messages,
    turns: input.window.turns,
    throughTurn: assessment.throughTurn,
    previousBytes: state.compaction
      ? compactionInputBytesV1(state.compaction.summary)
      : 0,
  });
  if (covered.length === 0) return { kind: "skipped", assessment };
  const effectId = input.newEffectId();
  // Intent before the effect: a summariser call is billed model spend. A
  // Turn that took the log first means nothing is begun.
  const intended = await log.append({
    type: "conversation/compaction-intent",
    effectId,
    throughTurn,
    provider: binding.provider,
    model: binding.model,
  });
  if (!intended) return { kind: "yielded" };
  const deadlineMs = input.deadlineMs ?? COMPACTION_DEADLINE_MS_V1;
  let choices: ReadonlyMap<LlmMessage, CompactionChoiceV1> | undefined;
  if (input.choose) {
    // A cleared timer, not AbortSignal.timeout: a pending timeout keeps the
    // Bot referenced long after the chooser has answered.
    const chooserController = new AbortController();
    const chooserDeadline = setTimeout(
      () =>
        chooserController.abort(
          new Error("The chooser ran past its deadline."),
        ),
      deadlineMs,
    );
    try {
      choices = await compactionChoicesV1(
        covered,
        input.choose,
        chooserController.signal,
      );
    } finally {
      clearTimeout(chooserDeadline);
    }
  }
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("The summariser ran past its deadline.")),
    deadlineMs,
  );
  let outcome: ParkedCompactionV1;
  let result: CompactionOutcomeV1;
  try {
    const text = await input.summarise({
      ...binding,
      effectId,
      system: COMPACTION_SYSTEM_PROMPT_V1,
      messages: compactionRequestMessagesV1({
        messages: covered,
        ...(state.compaction ? { previous: state.compaction } : {}),
        ...(choices ? { choices } : {}),
      }),
      signal: controller.signal,
    });
    const parsed = parseCompactionSummaryV1(text);
    if (!parsed) throw new Error("The summariser returned nothing usable.");
    outcome = {
      type: "conversation/compacted",
      effectId,
      fromTurn,
      throughTurn,
      summary: parsed.summary,
      identifiers: parsed.identifiers,
      provider: binding.provider,
      model: binding.model,
    };
    result = { kind: "compacted", throughTurn, fromTurn };
  } catch (error) {
    const reason = compactionFailureReasonV1(error);
    outcome = {
      type: "conversation/compaction-failed",
      effectId,
      throughTurn,
      reason,
    };
    result = { kind: "failed", throughTurn, reason };
  } finally {
    clearTimeout(deadline);
  }
  if (await log.append(outcome)) return result;
  await log.park(outcome);
  return { kind: "parked", throughTurn };
}

/**
 * What the chooser makes of a slice's messages. Only the person's messages
 * and tool results long enough to matter are asked about; a person's words
 * are never dropped, and what is kept stops at a budget, so the summary stays
 * inside its length. A chooser that fails leaves every message summarised.
 */
export async function compactionChoicesV1(
  covered: readonly LlmMessage[],
  choose: CompactionChooserV1,
  signal: AbortSignal,
): Promise<ReadonlyMap<LlmMessage, CompactionChoiceV1> | undefined> {
  const asked = covered
    .filter(
      (message) =>
        (message.role === "user" || message.role === "tool") &&
        message.content.length >= COMPACTION_CHOICE_MIN_CHARS_V1,
    )
    .slice(0, COMPACTION_CHOICE_ITEMS_MAX_V1);
  if (asked.length === 0) return undefined;
  let answers: readonly CompactionChoiceV1[] | undefined;
  try {
    answers = await choose(
      asked.map((message) =>
        message.role === "tool"
          ? { role: "tool", tool: message.name, text: message.content }
          : { role: "user", text: message.content },
      ),
      signal,
    );
  } catch {
    return undefined;
  }
  if (!answers || answers.length !== asked.length) return undefined;
  const choices = new Map<LlmMessage, CompactionChoiceV1>();
  let kept = 0;
  asked.forEach((message, index) => {
    let choice = answers[index]!;
    if (choice === "drop" && message.role !== "tool") choice = "summarise";
    if (choice === "keep") {
      const size = message.content.length;
      if (
        size > COMPACTION_KEEP_ITEM_MAX_CHARS_V1 ||
        kept + size > COMPACTION_KEEP_MAX_CHARS_V1
      )
        choice = "summarise";
      else kept += size;
    }
    if (choice !== "summarise") choices.set(message, choice);
  });
  return choices;
}

/**
 * The oldest whole Turns, up to `throughTurn`, that one summariser call can
 * read. Always at least one Turn, so a Turn larger than the cap is summarised
 * from its truncated transcript rather than blocking every later one.
 */
export function compactionSliceV1(input: {
  messages: readonly LlmMessage[];
  turns: readonly number[];
  throughTurn: number;
  previousBytes: number;
}): { throughTurn: number; covered: LlmMessage[] } {
  const covered: LlmMessage[] = [];
  let spent = input.previousBytes;
  let through = 0;
  let index = 0;
  while (index < input.messages.length) {
    const turn = input.turns[index]!;
    if (turn > input.throughTurn) break;
    let end = index;
    while (end < input.messages.length && input.turns[end] === turn) end += 1;
    const messages = input.messages.slice(index, end);
    const bytes = compactionInputBytesV1(compactionTranscriptV1(messages));
    if (through > 0 && spent + bytes > COMPACTION_INPUT_MAX_BYTES_V1) break;
    covered.push(...messages);
    spent += bytes;
    through = turn;
    index = end;
  }
  return { throughTurn: through, covered };
}

/** Truncates a failure description to what the event accepts. */
export function compactionFailureReasonV1(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const collapsed = message.replaceAll(/\s+/g, " ").trim();
  return (
    collapsed.slice(0, COMPACTION_FAILURE_REASON_MAX_LENGTH) ||
    "unknown failure"
  );
}
