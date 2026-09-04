// Compaction: how a conversation keeps its beginning instead of forgetting it.
//
// ADR 0027 bounded one model request and evicts whole Turns oldest-first when
// it overflows. ADR 0030 puts two tiers in front of that eviction, and this
// module is both of them plus the decision of when to reach for either:
//
//  1. **Prune old tool outputs.** A deterministic assembly rule, no durable
//     write and no model call. A `tool/result` message older than the newest
//     few Turns keeps its `callId` and `name` and loses only its payload, so
//     the call/result pairing every provider validates survives while the
//     bytes that actually dominate a long conversation do not.
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
  type Session,
  type SessionEvent,
  type StructuredOutputSchemaV1,
} from "@frockbot/kernel-contracts";

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

/** Time one summariser call is allowed. */
export const COMPACTION_DEADLINE_MS_V1 = 60_000;

/** Most Turn ends a retry ever waits after a failure. */
export const COMPACTION_MAX_BACKOFF_TURNS_V1 = 8;

/** The line a person sees in the transcript where a compaction stands. */
export const COMPACTED_ANNOUNCEMENT_TEXT_V1 =
  "Earlier messages were summarised";

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
  /** The Turn the newest failure covered, for backoff. */
  lastFailureThroughTurn: number;
}

export function compactionStateV1(
  events: readonly SessionEvent[],
): CompactionStateV1 {
  let compaction: CompactionV1 | undefined;
  let unsettled: { effectId: string; throughTurn: number } | undefined;
  let failures = 0;
  let lastFailureThroughTurn = 0;
  for (const event of events) {
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
      lastFailureThroughTurn = 0;
      continue;
    }
    if (event.type === "conversation/compaction-failed") {
      if (unsettled?.effectId === event.effectId) unsettled = undefined;
      failures += 1;
      lastFailureThroughTurn = event.throughTurn;
    }
  }
  return {
    ...(compaction ? { compaction } : {}),
    ...(unsettled ? { unsettled } : {}),
    failures,
    lastFailureThroughTurn,
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

/** The character measure ADR 0027 chose, over whatever window it is given. */
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
    if (input.currentTurn - input.state.lastFailureThroughTurn < wait) {
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
 * a paraphrased Package id, Applet id, Session id or Workspace path becomes a
 * later tool call with a plausible-looking wrong argument. Asking the model to
 * *list* what it saw is a far stronger constraint than asking it not to mangle
 * ids in passing, and the list is what the event stores.
 */
export const COMPACTION_SYSTEM_PROMPT_V1 = [
  "You are compressing the earlier part of a conversation so it can be carried forward in a smaller prompt.",
  "",
  "CRITICAL: You MUST preserve ALL opaque identifiers exactly as they appear. That includes UUIDs, hashes, full URLs with their query parameters, file and Workspace paths, Package ids, Applet ids, Bot ids, Session ids, tool call ids, model names and version strings. Do NOT paraphrase, abbreviate, or generalise an identifier. Copy it exactly.",
  "",
  "Put the gist in `summary`, decisions and their reasons in `decisions`, pending work in `openItems`, and every opaque identifier copied exactly in `identifiers`. Keep only the latest decision where one superseded another.",
  "",
  "Leave out pleasantries, repetition, and superseded detail. Do not invent anything that is not in the transcript. Do not address the user.",
].join("\n");

export interface CompactionSummaryPayloadV1 {
  summary: string;
  decisions: string[];
  openItems: string[];
  identifiers: string[];
}

/** The actual production consumer of the shared structured-output seam. */
export const COMPACTION_RESPONSE_SCHEMA_V1 = {
  type: "object",
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    openItems: { type: "array", items: { type: "string" } },
    identifiers: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "decisions", "openItems", "identifiers"],
  additionalProperties: false,
} as const satisfies StructuredOutputSchemaV1;

/** Keeps the durable summary format readable while model I/O stays typed. */
export function renderCompactionSummaryV1(
  payload: CompactionSummaryPayloadV1,
): string {
  const bullets = (values: readonly string[]) =>
    values.length > 0
      ? values.map((value) => `- ${value}`).join("\n")
      : "- none";
  return [
    "## Summary",
    payload.summary,
    "",
    "## Decisions",
    bullets(payload.decisions),
    "",
    "## Open items",
    bullets(payload.openItems),
    "",
    "## Identifiers mentioned",
    bullets(payload.identifiers),
  ].join("\n");
}

/** The transcript one summariser call is given, flattened to plain text. */
export function compactionTranscriptV1(
  messages: readonly LlmMessage[],
): string {
  return messages
    .map((message) => {
      if (message.role === "user") return `USER: ${message.content}`;
      if (message.role === "tool") {
        return `[tool-result ${message.name}${message.isError ? " (error)" : ""}: ${message.content}]`;
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

/** The one user message a summariser request carries. */
export function compactionRequestMessagesV1(input: {
  messages: readonly LlmMessage[];
  previous?: CompactionV1;
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
  return [
    {
      role: "user",
      content: `${preamble}--- transcript to summarise ---\n${compactionTranscriptV1(input.messages)}\n--- end transcript ---`,
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
  | { kind: "failed"; throughTurn: number; reason: string };

export interface CompactionRunnerV1 {
  /** The whole log, and the append surface the events are written to. */
  session: Session;
  /** The chat-only window the next request would carry, already narrowed. */
  window: {
    messages: readonly LlmMessage[];
    turns: readonly number[];
    chatTurns: readonly number[];
    state: CompactionStateV1;
  };
  budget: number;
  currentTurn: number;
  newEffectId(): string;
  /** One bounded summariser call on the Bot's own model binding. */
  summarise(
    request: CompactionModelV1 & {
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
 * check and the append. Failure is never fatal — the request that follows is
 * exactly the request ADR 0027 would have assembled.
 */
export async function runCompactionV1(
  input: CompactionRunnerV1,
): Promise<CompactionOutcomeV1> {
  const session = input.session;
  const state = input.window.state;
  if (state.unsettled) {
    // A restart interrupted an attempt. Its outcome is unknowable, so it is
    // settled as a failure and backoff schedules the retry (ADR 0028).
    session.append({
      type: "conversation/compaction-failed",
      effectId: state.unsettled.effectId,
      throughTurn: state.unsettled.throughTurn,
      reason: "Interrupted before a summary was recorded.",
    });
    await input.session.flush();
    return {
      kind: "failed",
      throughTurn: state.unsettled.throughTurn,
      reason: "interrupted",
    };
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
  const { throughTurn, fromTurn } = assessment;
  const binding = compactionModelV1(input.session.events);
  if (!binding) return { kind: "skipped", assessment };
  const covered: LlmMessage[] = [];
  for (const [index, message] of input.window.messages.entries()) {
    if (input.window.turns[index]! <= throughTurn) covered.push(message);
  }
  if (covered.length === 0) return { kind: "skipped", assessment };
  const effectId = input.newEffectId();
  // Intent before the effect: a summariser call is billed model spend.
  session.append({
    type: "conversation/compaction-intent",
    effectId,
    throughTurn,
    provider: binding.provider,
    model: binding.model,
  });
  await input.session.flush();
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("The summariser ran past its deadline.")),
    input.deadlineMs ?? COMPACTION_DEADLINE_MS_V1,
  );
  try {
    const text = await input.summarise({
      ...binding,
      system: COMPACTION_SYSTEM_PROMPT_V1,
      messages: compactionRequestMessagesV1({
        messages: covered,
        ...(state.compaction ? { previous: state.compaction } : {}),
      }),
      signal: controller.signal,
    });
    const parsed = parseCompactionSummaryV1(text);
    if (!parsed) throw new Error("The summariser returned nothing usable.");
    session.append({
      type: "conversation/compacted",
      effectId,
      fromTurn,
      throughTurn,
      summary: parsed.summary,
      identifiers: parsed.identifiers,
      provider: binding.provider,
      model: binding.model,
    });
    await input.session.flush();
    return { kind: "compacted", throughTurn, fromTurn };
  } catch (error) {
    const reason = compactionFailureReasonV1(error);
    session.append({
      type: "conversation/compaction-failed",
      effectId,
      throughTurn,
      reason,
    });
    await input.session.flush();
    return { kind: "failed", throughTurn, reason };
  } finally {
    clearTimeout(deadline);
  }
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
