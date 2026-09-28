import {
  appendRuntimeNoteV1,
  runtimeNoteLabelV1,
  BATCH_TOOL_NAME,
  canonicalJson,
  decodeBatchCallsV1,
  defaultTurnDirectiveV1,
  emptyFailureStateV1,
  emptyPolicySnapshotV1,
  SUPERVISION_ARGUMENTS_CHANGED_PREFIX_V1,
  SUPERVISION_NOT_AUTHORIZED_PREFIX_V1,
  SUPERVISION_OFF_TASK_PREFIX_V1,
  SUPERVISION_WITHHELD_SEND_PREFIX_V1,
  sha256,
  type CallDecisionV1,
  type CallReviewEvidenceV1,
  type ConversationEvidenceV1,
  type InputSegmentV1,
  type QuestionRouteV1,
  type LlmMessage,
  type LoopHooksV1,
  type ProgressDecisionV1,
  type ProposedCallV1,
  type SendDecisionV1,
  type Session,
  type SessionEvent,
  type StepDecision,
  type StepProposalEvidence,
  type SupervisionReasonCode,
  type ToolCall,
  type TurnDirective,
  type TurnInputOriginV1,
  type TurnSupervisor,
  withheldSendEndsTurnV1,
} from "@frockbot/core/contracts";
import type { StoredRunOriginV1 } from "@frockbot/core/durable";
import { resolveDynamicToolNameV1 } from "../audit/classify.js";
import { SUBAGENT_SUMMARY_END_V1 } from "../routines/inbox.js";
import type { FoundationFeature } from "../runtime.js";
import { loopSignalsV1, progressCheckDueV1 } from "./loop-health.js";

// Turn supervision, mounted into the loop. Jev judges; this file enforces.
//
// - Before a Turn's first model call, the start-of-Turn judgment. When it
//   says the person is waiting on real work, the first request carries a
//   runtime note asking for a short acknowledgement first. The note sits at
//   the tail of that one request, never in the system prompt, so the cached
//   prefix is untouched. When it names a specialist the Turn is offered, the
//   same note hands that work to the specialist.
// - Once per response that calls tools, before any of them runs: is it
//   working on what was asked. A response pursuing something else has every
//   call that is not the Bot speaking refused, and its text sends withheld.
// - Right before each text send runs: does it say something was done that
//   the Turn did not do, and would the person miss it. A withheld send is
//   never delivered and its draft is cleared. A redundant finish still ends
//   the Turn, because the person already has what it would say; one that
//   claimed undone work does not, so the Turn can do it or say so.
// - Every few steps of a long Turn, before its model call: is it still
//   getting anywhere. A stuck Turn is told, in that request, to change course.
// - Right before each `mutate` call runs — a Plugin a User installed or a Bot
//   wrote, a remote MCP server, a connected app: did the person ask for it,
//   with these particulars. A refused call never runs; the model reads why
//   and asks the person in conversation.
//
// Every decision is a session event, read back rather than asked again when a
// Turn resumes, and inspectable per Turn through `/api/debug`. Mounted first,
// so no Plugin hook sees a call supervision refused.

export interface SupervisionRuntimeHostV1 {
  /** The product runtime notes are labelled with. */
  readonly productName: string;
  readonly supervisor: TurnSupervisor;
  /** Where this Turn's input came from. */
  readonly origin: TurnInputOriginV1;
  /**
   * Clears the reply draft a step is showing, from the send at `ordinal`
   * among the run's sends. Absent where nobody is drawn a draft.
   */
  clearReplyDraft?(ordinal: number): void;
  /**
   * The specialists this Turn may hand work to, by name, with the slug a
   * `Task` names them by. Read at the first request, once they are known.
   */
  specialists?(): readonly { name: string; slug: string }[];
}

/** What a run's origin says about who is on the other end of its Turn. */
export function turnInputOriginV1(
  origin: StoredRunOriginV1 | undefined,
): TurnInputOriginV1 {
  switch (origin?.kind) {
    case undefined:
    case "input-delivery":
      return "user";
    case "email":
      return "email";
    case "group":
      return "group";
    case "voice":
      return "voice";
    case "routine":
    case "routine-delivery":
      return "schedule";
    case "subagent":
      return "subagent";
    case "handoff":
    case "bot":
      return "agent";
  }
}

const SEND_TO_USER = "send_to_user";
const REPLY_TO_REQUEST = "reply_to_request";
/** A background Turn's hand-off: the only thing it ever says. */
const WAKE_PARENT = "wake_parent";

/** The earlier conversation Jev is shown, most recent last. */
export const SUPERVISION_CONVERSATION_MAX_V1 = 8;

/** Runtime notes carry a label so the model reads them as the platform's. */
export function acknowledgeNoteV1(productName: string): string {
  return `${runtimeNoteLabelV1(productName, "acknowledge first")}\nThis will take some work. Before you start it, send the person one short line with send_to_user (disposition "continue") saying what you are about to do. Then do the work.`;
}

/** How a stuck Turn is steered, offered the thinking specialist when it has it. */
export function stuckNoteV1(
  productName: string,
  thinking?: { slug: string },
): string {
  const mentor = thinking
    ? `, hand the problem to the thinking specialist (call Task with model "${thinking.slug}" and a brief of what you tried and what happened)`
    : "";
  return `${runtimeNoteLabelV1(productName, "not getting anywhere")}\nYour last few steps have not moved the work forward. Stop repeating what has not worked. Try a different approach${mentor}, or tell the person what is blocking you and ask how to go on.`;
}

/** How a Turn is steered to answer a question its subagent asked. */
export function questionNoteV1(
  productName: string,
  answerer: "conversation" | "person",
): string {
  const label = runtimeNoteLabelV1(productName, "subagent question");
  return answerer === "conversation"
    ? `${label}\nWhat the person has already said answers your subagent's question. Answer it from that with task_resume; do not ask the person.`
    : `${label}\nOnly the person can answer your subagent's question. Ask them in your own words, then pass their answer on with task_resume.`;
}

/**
 * The question a subagent asked, when this Turn was opened for it: read off
 * the notice `app/subagents` writes when a task hands off a question.
 */
export function subagentQuestionOfTurnV1(
  events: readonly SessionEvent[],
  turn: number,
): string | undefined {
  const notice =
    /subagent "[^"\n]*" asked a question\. It asks: ([\s\S]+?) It is waiting: answer with task_resume/;
  for (const event of turnEvents(events, turn)) {
    if (event.type !== "user/message") continue;
    const question = notice.exec(event.text)?.[1]?.trim();
    if (question) return question;
  }
  return undefined;
}

function questionRouteOf(
  events: readonly SessionEvent[],
  turn: number,
): QuestionRouteV1 | undefined {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "supervision/question" && candidate.turn === turn,
  );
  return event?.type === "supervision/question" ? event.route : undefined;
}

/** Where a Turn is steered when Jev names a specialist it is offered. */
export function specialistNoteV1(
  productName: string,
  specialist: {
    name: string;
    slug: string;
  },
): string {
  return `${runtimeNoteLabelV1(productName, "specialist")}\nThis is ${specialist.name} work, which the ${specialist.name} specialist does better than you. Hand it over: call Task with model "${specialist.slug}" and a complete brief. When it comes back, give the person what it produced as it wrote it.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain text send's words, or `undefined` for any other call. */
export function textSendV1(
  tool: string,
  input: unknown,
): { text: string; finish: boolean } | undefined {
  if (tool !== SEND_TO_USER || !isRecord(input)) return undefined;
  const payload = input.payload;
  if (!isRecord(payload) || payload.type !== "text") return undefined;
  if (typeof payload.text !== "string") return undefined;
  return { text: payload.text, finish: input.disposition === "finish" };
}

function speaks(tool: string): boolean {
  return (
    tool === SEND_TO_USER || tool === REPLY_TO_REQUEST || tool === WAKE_PARENT
  );
}

/** A hand-off's message, when the call is one. */
function handoffMessageV1(tool: string, input: unknown): string | undefined {
  if (tool !== WAKE_PARENT || !isRecord(input)) return undefined;
  return typeof input.message === "string" && input.message.trim()
    ? input.message
    : undefined;
}

/** The step's calls, a batch opened into the calls it carries. */
function flattenCalls(
  calls: readonly ToolCall[],
): { id: string; tool: string; input: unknown }[] {
  return calls.flatMap((call) => {
    if (call.name !== BATCH_TOOL_NAME) {
      return [{ id: call.id, tool: call.name, input: call.input }];
    }
    const decoded = decodeBatchCallsV1(call.input);
    if (typeof decoded === "string") return [];
    return decoded.flatMap((sub, index) =>
      sub.kind === "call"
        ? [{ id: `${call.id}.${index}`, tool: sub.tool, input: sub.arguments }]
        : [],
    );
  });
}

/** `tool:<turn>:<step>:<ordinal>`, with `.<index>` for a batch sub-call. */
function occurrenceTurnStep(
  occurrenceId: string,
): { turn: number; step: number } | undefined {
  const match = /^tool:(\d+):(\d+):/.exec(occurrenceId);
  if (!match) return undefined;
  return { turn: Number(match[1]), step: Number(match[2]) };
}

function turnEvents(
  events: readonly SessionEvent[],
  turn: number,
): SessionEvent[] {
  return events.filter((event) => "turn" in event && event.turn === turn);
}

/**
 * Who wrote an input that records no parts: its origin. A Turn a person sent
 * is theirs; anything else the host admitted records its parts, so this is
 * only ever a person's Turn or an input admitted before parts were recorded.
 */
function originAuthorV1(origin: TurnInputOriginV1): InputSegmentV1["author"] {
  return origin === "user" ||
    origin === "voice" ||
    origin === "email" ||
    origin === "group"
    ? "person"
    : "bot";
}

/** Each part of the Turn's input, oldest first, with who wrote it. */
function turnSegments(
  events: readonly SessionEvent[],
  turn: number,
  origin: TurnInputOriginV1,
): InputSegmentV1[] {
  return turnEvents(events, turn).flatMap((event) =>
    event.type === "user/message"
      ? (event.segments ?? [
          { author: originAuthorV1(origin), text: event.text },
        ])
      : [],
  );
}

function asks(author: InputSegmentV1["author"]): boolean {
  return author === "person" || author === "routine";
}

/** The line that separates what the person asked from what arrived with it. */
export const SUPERVISION_CONTEXT_LABEL_V1 =
  "Also in this Turn's input, written by others, not by the person:";

/**
 * What the Turn was asked, oldest first, then what arrived with it. The
 * person's words lead, so a check that reads only the start of a long input
 * still reads them; a hand-off drained in front of them follows, labelled as
 * someone else's.
 */
function inputText(
  events: readonly SessionEvent[],
  turn: number,
  origin: TurnInputOriginV1,
): string {
  return turnObjectiveV1(turnSegments(events, turn, origin));
}

/** The objective every check reads, from the parts of a Turn's input. */
export function turnObjectiveV1(segments: readonly InputSegmentV1[]): string {
  const join = (parts: readonly InputSegmentV1[], separator: string) =>
    parts
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join(separator);
  const asked = join(
    segments.filter((part) => asks(part.author)),
    "\n\n",
  );
  const context = join(
    segments.filter((part) => !asks(part.author)),
    "\n",
  );
  if (!context) return asked;
  if (!asked) return context;
  return `${asked}\n\n${SUPERVISION_CONTEXT_LABEL_V1}\n${context}`;
}

const SPEAKER_OF_AUTHOR_V1: Record<
  InputSegmentV1["author"],
  ConversationEvidenceV1["speaker"]
> = {
  person: "user",
  routine: "routine",
  bot: "bot",
  plugin: "context",
  platform: "context",
  external: "context",
};

/** Whether the Turn owes its answer to a caller, by the tools it offered. */
function callerAddressed(
  events: readonly SessionEvent[],
  turn: number,
): boolean {
  return events.some(
    (event) =>
      event.type === "model/request" &&
      event.turn === turn &&
      event.request.tools.some((tool) => tool.name === REPLY_TO_REQUEST),
  );
}

function describeShown(event: SessionEvent): string | undefined {
  if (event.type !== "send/to-user") return undefined;
  const payload = event.payload;
  switch (payload.type) {
    case "text":
      return payload.text;
    case "widget":
      return `Question: ${payload.widget.prompt}`;
    case "secret-request":
      return `Asked for a secret: ${payload.prompt}`;
    case "approval":
      return `Asked for approval: ${payload.action}`;
    default:
      return `Showed a ${payload.type}: ${JSON.stringify(payload)}`;
  }
}

/** What the person has already been shown this Turn, oldest first. */
function shownThisTurn(
  events: readonly SessionEvent[],
  turn: number,
): string[] {
  return turnEvents(events, turn).flatMap((event) => {
    const shown = describeShown(event);
    return shown === undefined ? [] : [shown];
  });
}

/** The Turn's results, each named by the tool that ran, not its wrapper. */
function priorResults(events: readonly SessionEvent[], turn: number) {
  const inputs = new Map<string, unknown>();
  return turnEvents(events, turn).flatMap((event) => {
    if (event.type === "tool/call") inputs.set(event.occurrenceId, event.input);
    if (event.type !== "tool/result") return [];
    const input = inputs.get(event.occurrenceId);
    return [
      {
        callId: event.occurrenceId,
        tool: resolveDynamicToolNameV1(event.name, input),
        arguments: dynamicArgumentsV1(event.name, input),
        content: event.content,
        isError: event.isError,
      },
    ];
  });
}

/** What a call was given: a dynamic call's inner arguments, else its input. */
function dynamicArgumentsV1(name: string, input: unknown): unknown {
  return name === "call_dynamic_tool" &&
    isRecord(input) &&
    isRecord(input.arguments)
    ? input.arguments
    : input;
}

/** The Turn's settled calls, oldest first, each with what it was given. */
function settledCalls(events: readonly SessionEvent[], turn: number) {
  const inputs = new Map<string, unknown>();
  return turnEvents(events, turn).flatMap((event) => {
    if (event.type === "tool/call") inputs.set(event.occurrenceId, event.input);
    if (event.type !== "tool/result") return [];
    const input = inputs.get(event.occurrenceId);
    return [
      {
        tool: resolveDynamicToolNameV1(event.name, input),
        input: JSON.stringify(input ?? null),
        result: event.content,
        isError: event.isError,
      },
    ];
  });
}

function progressChecksOf(
  events: readonly SessionEvent[],
  turn: number,
): { step: number; decision: ProgressDecisionV1 }[] {
  return events.flatMap((event) =>
    event.type === "supervision/progress" && event.turn === turn
      ? [{ step: event.step, decision: event.decision }]
      : [],
  );
}

function messageSpeech(message: LlmMessage): ConversationEvidenceV1[] {
  if (message.role === "user") {
    return message.content.trim()
      ? [{ speaker: "user", text: message.content }]
      : [];
  }
  if (message.role !== "assistant") return [];
  // A Bot's visible words are its sends; its assistant text is private.
  return message.toolCalls.flatMap((call) =>
    flattenCalls([call]).flatMap((flat) => {
      const send = textSendV1(flat.tool, flat.input);
      if (send) return [{ speaker: "bot" as const, text: send.text }];
      if (flat.tool === REPLY_TO_REQUEST && isRecord(flat.input)) {
        const answer = flat.input.answer;
        return typeof answer === "string"
          ? [{ speaker: "bot" as const, text: answer }]
          : [];
      }
      return [];
    }),
  );
}

/** The conversation before the Turn, as the person and the Bot said it. */
function conversationBefore(session: Session): ConversationEvidenceV1[] {
  return session.committedContext.turns
    .flatMap((turn) => turn.messages.flatMap(messageSpeech))
    .slice(-SUPERVISION_CONVERSATION_MAX_V1);
}

function directiveOf(
  events: readonly SessionEvent[],
  turn: number,
): TurnDirective | undefined {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "supervision/turn-start" && candidate.turn === turn,
  );
  return event?.type === "supervision/turn-start" ? event.directive : undefined;
}

function stepDecisionOf(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
): StepDecision | undefined {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "supervision/step" &&
      candidate.turn === turn &&
      candidate.step === step,
  );
  return event?.type === "supervision/step" ? event.decision : undefined;
}

function sendDecisionOf(
  events: readonly SessionEvent[],
  occurrenceId: string,
): SendDecisionV1 | undefined {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "supervision/send" &&
      candidate.occurrenceId === occurrenceId,
  );
  return event?.type === "supervision/send" ? event.decision : undefined;
}

/** What a `supervision/call` verdict is bound to: the exact reviewed call. */
function reviewedCallDigestV1(call: {
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  return sha256(canonicalJson({ tool: call.tool, arguments: call.arguments }));
}

/**
 * The verdict recorded for this occurrence, only when it was given for this
 * exact call. An id alone is not enough: a synthetic id reused for a
 * different request must be reviewed afresh, never handed an earlier allow.
 */
function callDecisionOf(
  events: readonly SessionEvent[],
  occurrenceId: string,
  callDigest: string,
): CallDecisionV1 | undefined {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "supervision/call" &&
      candidate.occurrenceId === occurrenceId,
  );
  return event?.type === "supervision/call" && event.callDigest === callDigest
    ? event.decision
    : undefined;
}

/** The Turn's own requests and what the Bot has said in it, in order. */
function conversationThisTurn(
  events: readonly SessionEvent[],
  turn: number,
  origin: TurnInputOriginV1,
): ConversationEvidenceV1[] {
  return turnEvents(events, turn).flatMap((event): ConversationEvidenceV1[] => {
    if (event.type === "user/message") {
      return (
        event.segments ?? [{ author: originAuthorV1(origin), text: event.text }]
      ).flatMap((part) =>
        part.text.trim()
          ? [{ speaker: SPEAKER_OF_AUTHOR_V1[part.author], text: part.text }]
          : [],
      );
    }
    const shown = describeShown(event);
    return shown === undefined ? [] : [{ speaker: "bot", text: shown }];
  });
}

/**
 * What step review is shown about one response, from the journal as it
 * stands when the response arrives. Exported so an eval built from a recorded
 * Turn sees exactly what production did; the earlier conversation is passed
 * in because it lives outside this Turn's journal.
 */
export function stepReviewEvidenceOfV1(
  events: readonly SessionEvent[],
  turn: number,
  origin: TurnInputOriginV1,
  toolCalls: readonly ToolCall[],
  conversation: readonly ConversationEvidenceV1[],
): StepProposalEvidence {
  const flat = flattenCalls(toolCalls);
  const text = flat
    .flatMap((call) => {
      const send = textSendV1(call.tool, call.input);
      return send ? [send.text] : [];
    })
    .join("\n\n");
  const calls: ProposedCallV1[] = flat
    .filter((call) => !textSendV1(call.tool, call.input))
    .map((call) => ({
      callId: call.id,
      tool: call.tool,
      arguments: isRecord(call.input) ? call.input : {},
      effect: "mutate" as const,
      ...(speaks(call.tool) ? { speaks: true } : {}),
    }));
  return {
    objective: inputText(events, turn, origin),
    origin,
    startDirective: directiveOf(events, turn) ?? defaultTurnDirectiveV1(),
    text,
    calls,
    conversation,
    shown: shownThisTurn(events, turn),
    policies: emptyPolicySnapshotV1(),
    authorizations: [],
    priorResults: priorResults(events, turn),
    specialistAdvice: [],
    failure: emptyFailureStateV1(),
    continuationCandidates: [],
    finalStep: false,
  };
}

/**
 * What call review is shown about one call, from the journal as it stands
 * when the call is prepared. Exported so an eval built from a recorded Turn
 * sees exactly what production did.
 */
export function callReviewEvidenceOfV1(
  events: readonly SessionEvent[],
  turn: number,
  origin: TurnInputOriginV1,
  call: CallReviewEvidenceV1["call"],
): CallReviewEvidenceV1 {
  return {
    objective: inputText(events, turn, origin),
    origin,
    call,
    // This Turn only. An earlier Turn's user messages also carry text the
    // person did not type — a Routine's hand-off, a card press, another Bot
    // in a group — and nothing records which, so they must not stand as
    // authorization here.
    conversation: conversationThisTurn(events, turn, origin),
    priorResults: priorResults(events, turn),
    policies: emptyPolicySnapshotV1(),
  };
}

/**
 * Whether a step withheld a send that would have ended the Turn. A Turn that
 * owes a caller its answer is not ended by a send, withheld or not.
 */
export function withheldFinishV1(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
): boolean {
  if (callerAddressed(events, turn)) return false;
  return events.some(
    (event) =>
      event.type === "supervision/send" &&
      event.turn === turn &&
      event.step === step &&
      event.finish &&
      event.decision.send === "withhold" &&
      withheldSendEndsTurnV1(event.decision.reason),
  );
}

/** Whether a send this Turn was already withheld for `reason`. */
function withheldForV1(
  events: readonly SessionEvent[],
  turn: number,
  ...reasons: ("paraphrased_work" | "unsupported_claim" | "unsupported_fact")[]
): boolean {
  return events.some(
    (event) =>
      event.type === "supervision/send" &&
      event.turn === turn &&
      event.decision.send === "withhold" &&
      event.decision.reason !== undefined &&
      (reasons as string[]).includes(event.decision.reason),
  );
}

/**
 * The work a subagent handed back this Turn: a blocking dispatch's result,
 * or a background task's completion the Turn was opened for. Read off the
 * words `app/subagents` writes for each; anything else is not a subagent's.
 */
export function subagentWorkV1(
  events: readonly SessionEvent[],
  turn: number,
): string[] {
  const settled =
    /^(?:\w+ subagent \S+|Subagent \S+ resumed and) completed\. ([\s\S]+)$/;
  const notice = new RegExp(
    `(?:^|\\n)\\w+ subagent "[^"\\n]*" completed\\. ([\\s\\S]+?)\\n${escapeRegExp(SUBAGENT_SUMMARY_END_V1)}`,
    "g",
  );
  return turnEvents(events, turn).flatMap((event) => {
    const matches =
      event.type === "tool/result" && !event.isError
        ? [settled.exec(event.content)]
        : event.type === "user/message"
          ? [...event.text.matchAll(notice)]
          : [];
    return matches.flatMap((match) => {
      const work = match?.[1]?.trim();
      // A question the subagent asked is not work it made.
      return work && !work.startsWith("It asks: ") ? [work] : [];
    });
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function withheldResult(
  reason:
    | "off_task"
    | "redundant_text"
    | "paraphrased_work"
    | "unsupported_claim"
    | "unsupported_fact",
  finish: boolean,
  addressed: boolean,
): string {
  if (reason === "unsupported_fact") {
    return `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} because it says a page said something that the pages this Turn read do not say. Say only what they say, or say plainly that you could not find it.`;
  }
  if (reason === "unsupported_claim") {
    return `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} because it says something was done that this Turn's results do not show done. Do it now, or tell the person plainly that it is not done and why.`;
  }
  if (reason === "paraphrased_work") {
    return `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} because the person asked for the work itself and this rewrites it. Send what the subagent produced as it was written, whole; one short line before it is fine.`;
  }
  const why =
    reason === "redundant_text"
      ? "because the person can already see what it says."
      : "because it is not about what the person asked for.";
  const next =
    finish && !addressed && reason === "redundant_text"
      ? " The Turn is complete; do not send it again."
      : reason === "redundant_text"
        ? addressed
          ? ` Answer the caller with ${REPLY_TO_REQUEST}.`
          : " Carry on without repeating it."
        : " Go back to what they asked.";
  return `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} ${why}${next}`;
}

function withheldHandoffResult(
  reason: SupervisionReasonCode | undefined,
): string {
  return reason === "unsupported_fact"
    ? `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} because it says a page said something that the pages this Turn read do not say. Hand off again saying only what they say.`
    : `${SUPERVISION_WITHHELD_SEND_PREFIX_V1} because it says something was done that this Turn's results do not show done. Hand off again saying plainly what was and was not done.`;
}

function refusedCallResult(reason: string, origin: TurnInputOriginV1): string {
  // Nobody can be asked during a Routine, a subagent's task or a hand-off:
  // telling that Turn to ask the person sends it round again instead.
  if (origin === "schedule" || origin === "subagent" || origin === "agent") {
    return reason === "arguments_changed"
      ? `${SUPERVISION_ARGUMENTS_CHANGED_PREFIX_V1} Nobody can be asked during this work. Match what was asked, or leave the call out and say in your hand-off what it would have done.`
      : `${SUPERVISION_NOT_AUTHORIZED_PREFIX_V1} Nobody can be asked during this work. Leave it out, carry on with the rest, and say in your hand-off what it would have done.`;
  }
  return reason === "arguments_changed"
    ? `${SUPERVISION_ARGUMENTS_CHANGED_PREFIX_V1} A recipient, destination or the substance is not what they asked for. Match what they asked, or check with them in conversation first, saying exactly what the call will do.`
    : `${SUPERVISION_NOT_AUTHORIZED_PREFIX_V1} If it is needed, ask them in conversation first, saying exactly what it will do, and make the call once they agree.`;
}

function offTaskResult(objective: string): string {
  return `${SUPERVISION_OFF_TASK_PREFIX_V1} Go back to their request: ${clip(objective)}`;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(Date.now() - started));
}

export function createSupervisionRuntimeFeatureV1(
  host: SupervisionRuntimeHostV1,
): FoundationFeature {
  return (runtime) => {
    const sessionOf = (sessionId: string): Session => {
      const session = runtime.sessions.get(sessionId);
      if (!session) {
        throw new Error(`supervision: session "${sessionId}" is not open`);
      }
      return session;
    };

    /** Whether `step` opens stuck, asking Jev only when a check is due. */
    const checkProgress = async (
      session: Session,
      turn: number,
      step: number,
      signal: AbortSignal | undefined,
    ): Promise<boolean> => {
      const events = session.activeRunJournal;
      const checks = progressChecksOf(events, turn);
      const recorded = checks.find((check) => check.step === step);
      if (recorded) return recorded.decision.stuck;
      const calls = settledCalls(events, turn);
      const signals = loopSignalsV1(calls);
      if (
        !progressCheckDueV1({
          step,
          lastChecked: checks.at(-1)?.step ?? 0,
          signals,
        })
      ) {
        return false;
      }
      const started = Date.now();
      const decision = await host.supervisor.reviewProgress(
        {
          objective: inputText(events, turn, host.origin),
          origin: host.origin,
          step,
          actions: calls.map((call) => ({
            tool: call.tool,
            arguments: call.input,
            result: call.result,
            isError: call.isError,
          })),
          signals,
        },
        signal,
      );
      session.append({
        type: "supervision/progress",
        turn,
        step,
        decision,
        latencyMs: elapsed(started),
      });
      await session.flush();
      return decision.stuck;
    };

    /**
     * Whether a Turn that used tools did what was asked, as it stops. For
     * `/api/debug` alone: a judgment that fails is left out, never the Turn.
     */
    const judgeOutcome = async (
      session: Session,
      turn: number,
      step: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const events = session.activeRunJournal;
      if (
        events.some(
          (event) =>
            event.type === "supervision/outcome" && event.turn === turn,
        )
      ) {
        return;
      }
      const calls = settledCalls(events, turn).filter(
        (call) => !speaks(call.tool),
      );
      if (calls.length === 0) return;
      const started = Date.now();
      let decision;
      try {
        decision = await host.supervisor.reviewOutcome(
          {
            objective: inputText(events, turn, host.origin),
            origin: host.origin,
            actions: calls.map((call) => ({
              tool: call.tool,
              arguments: call.input,
              result: call.result,
              isError: call.isError,
            })),
            shown: shownThisTurn(events, turn),
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        return;
      }
      session.append({
        type: "supervision/outcome",
        turn,
        step,
        decision,
        latencyMs: elapsed(started),
      });
      await session.flush();
    };

    const hooks: LoopHooksV1 = {
      async request(agent, _request, turn, step, signal, next) {
        const request = await next();
        if (step !== 1) {
          const stuck = await checkProgress(agent.session, turn, step, signal);
          if (!stuck) return request;
          const thinking = host
            .specialists?.()
            .find((offered) => offered.name === "thinking");
          return appendRuntimeNoteV1(
            request,
            stuckNoteV1(host.productName, thinking),
          );
        }
        const session = agent.session;
        let directive = directiveOf(session.activeRunJournal, turn);
        if (!directive) {
          const started = Date.now();
          directive = await host.supervisor.startTurn(
            {
              input: {
                messageId: `turn:${turn}`,
                text: inputText(session.activeRunJournal, turn, host.origin),
                origin: host.origin,
              },
              policies: emptyPolicySnapshotV1(),
              authorizations: [],
              continuation: [],
              conversation: conversationBefore(session),
              specialists: [],
              failure: emptyFailureStateV1(),
            },
            signal,
          );
          session.append({
            type: "supervision/turn-start",
            turn,
            directive,
            latencyMs: elapsed(started),
          });
          await session.flush();
        }
        const specialist = directive.requiredCapabilities
          .map((name) =>
            host.specialists?.().find((offered) => offered.name === name),
          )
          .find((offered) => offered !== undefined);
        const question = subagentQuestionOfTurnV1(
          session.activeRunJournal,
          turn,
        );
        let route = questionRouteOf(session.activeRunJournal, turn);
        if (question !== undefined && !route) {
          const started = Date.now();
          route = await host.supervisor.routeQuestion(
            { question, conversation: conversationBefore(session) },
            signal,
          );
          session.append({
            type: "supervision/question",
            turn,
            route,
            latencyMs: elapsed(started),
          });
          await session.flush();
        }
        const notes = [
          ...(directive.acknowledge
            ? [acknowledgeNoteV1(host.productName)]
            : []),
          ...(specialist
            ? [specialistNoteV1(host.productName, specialist)]
            : []),
          ...(route ? [questionNoteV1(host.productName, route.answerer)] : []),
        ];
        return notes.reduce(appendRuntimeNoteV1, request);
      },

      async reviewResponse(agent, response, signal) {
        const session = agent.session;
        const events = session.activeRunJournal;
        if (stepDecisionOf(events, response.turn, response.step)) return;
        const started = Date.now();
        const decision = await host.supervisor.reviewStep(
          stepReviewEvidenceOfV1(
            events,
            response.turn,
            host.origin,
            response.toolCalls,
            conversationBefore(session),
          ),
          signal,
        );
        session.append({
          type: "supervision/step",
          turn: response.turn,
          step: response.step,
          requestId: response.requestId,
          decision,
          latencyMs: elapsed(started),
        });
        await session.flush();
      },

      async prepareTool(call, context, next) {
        const at = occurrenceTurnStep(context.effectId);
        if (!at) return next();
        const session = sessionOf(context.sessionId);
        const events = session.activeRunJournal;
        const decision = stepDecisionOf(events, at.turn, at.step);
        if (!decision) {
          throw new Error(
            `supervision: step ${at.turn}:${at.step} ran a call it never reviewed`,
          );
        }
        // A hand-off is what the person will be told the work did, so what it
        // says was done is checked against the Turn's results, once a Turn,
        // like a send. Whether it is needed is not asked: it is the only word
        // a background Turn has.
        const handoff = handoffMessageV1(call.name, call.input);
        if (
          handoff !== undefined &&
          (sendDecisionOf(events, context.effectId) !== undefined ||
            !withheldForV1(
              events,
              at.turn,
              "unsupported_claim",
              "unsupported_fact",
            ))
        ) {
          let verdict = sendDecisionOf(events, context.effectId);
          if (!verdict) {
            const started = Date.now();
            verdict = await host.supervisor.reviewSend(
              {
                objective: inputText(events, at.turn, host.origin),
                origin: host.origin,
                conversation: [],
                shown: [],
                priorResults: priorResults(events, at.turn),
                message: handoff,
                finish: true,
                work: [],
                checkClaim: true,
                handoff: true,
              },
              context.signal,
            );
            session.append({
              type: "supervision/send",
              turn: at.turn,
              step: at.step,
              occurrenceId: context.effectId,
              finish: true,
              decision: verdict,
              latencyMs: elapsed(started),
            });
            await session.flush();
          }
          if (verdict.send === "withhold") {
            return {
              kind: "denied",
              call,
              result: {
                content: withheldHandoffResult(verdict.reason),
                isError: false,
              },
            };
          }
          return next();
        }
        const send = textSendV1(call.name, call.input);
        if (!send) {
          if (
            decision.responseAlignment === "wrong-objective" &&
            !speaks(call.name)
          ) {
            return {
              kind: "denied",
              call,
              result: {
                content: offTaskResult(inputText(events, at.turn, host.origin)),
                isError: true,
              },
            };
          }
          if (context.effect === "mutate") {
            const outer = context.toolCall ?? call;
            const reviewed = {
              tool: resolveDynamicToolNameV1(outer.name, outer.input),
              arguments: isRecord(call.input) ? call.input : {},
            };
            const callDigest = await reviewedCallDigestV1(reviewed);
            let verdict = callDecisionOf(events, context.effectId, callDigest);
            if (!verdict) {
              const started = Date.now();
              verdict = await host.supervisor.reviewCall(
                callReviewEvidenceOfV1(events, at.turn, host.origin, reviewed),
                context.signal,
              );
              session.append({
                type: "supervision/call",
                turn: at.turn,
                step: at.step,
                occurrenceId: context.effectId,
                tool: reviewed.tool,
                callDigest,
                decision: verdict,
                latencyMs: elapsed(started),
              });
              await session.flush();
            }
            if (verdict.decision === "reject") {
              return {
                kind: "denied",
                call,
                result: {
                  content: refusedCallResult(verdict.reasonCode, host.origin),
                  isError: true,
                },
              };
            }
          }
          return next();
        }
        let verdict = sendDecisionOf(events, context.effectId);
        if (!verdict) {
          const started = Date.now();
          verdict =
            decision.text === "withhold"
              ? {
                  send: "withhold",
                  reason: decision.textReason ?? "off_task",
                  judgments: [],
                }
              : await host.supervisor.reviewSend(
                  {
                    objective: inputText(events, at.turn, host.origin),
                    origin: host.origin,
                    conversation: conversationBefore(session),
                    shown: shownThisTurn(events, at.turn),
                    priorResults: priorResults(events, at.turn),
                    message: send.text,
                    finish: send.finish,
                    work: withheldForV1(events, at.turn, "paraphrased_work")
                      ? []
                      : subagentWorkV1(events, at.turn),
                    checkClaim: !withheldForV1(
                      events,
                      at.turn,
                      "unsupported_claim",
                      "unsupported_fact",
                    ),
                  },
                  context.signal,
                );
          session.append({
            type: "supervision/send",
            turn: at.turn,
            step: at.step,
            occurrenceId: context.effectId,
            finish: send.finish,
            decision: verdict,
            latencyMs: elapsed(started),
          });
          await session.flush();
        }
        if (verdict.send === "release") return next();
        host.clearReplyDraft?.(
          events.filter(
            (event) =>
              event.type === "send/to-user" &&
              !(event.turn === at.turn && event.step === at.step),
          ).length,
        );
        return {
          kind: "denied",
          call,
          result: {
            content: withheldResult(
              verdict.reason === "redundant_text" ||
                verdict.reason === "paraphrased_work" ||
                verdict.reason === "unsupported_claim" ||
                verdict.reason === "unsupported_fact"
                ? verdict.reason
                : "off_task",
              send.finish,
              callerAddressed(events, at.turn),
            ),
            isError: false,
          },
        };
      },

      async stepContinuation(agent, _decision, turn, step, signal, next) {
        // Outermost, so nothing after it can reopen a Turn whose last word
        // the person already has. A caller-addressed Turn is left to delivery,
        // which keeps it going until the caller is answered.
        const decision = withheldFinishV1(
          agent.session.activeRunJournal,
          turn,
          step,
        )
          ? ({ kind: "stop" } as const)
          : await next();
        if (decision.kind === "stop") {
          await judgeOutcome(agent.session, turn, step, signal);
        }
        return decision;
      },
    };
    const dispose = runtime.hooks.add(hooks);
    return () => dispose();
  };
}
