import {
  decodeSendToUserPayloadV1,
  type SendToUserPayloadV1,
} from "./send-to-user.js";
import { decodeWorkspacePathV1, type WorkspacePathV1 } from "./workspace.js";
import {
  decodeSkillRefV1,
  decodeSkillRefsV1,
  type SkillRefV1,
} from "./skills.js";
import {
  decodeMessageAttachmentsV1,
  type MessageAttachmentV1,
} from "./message-attachments.js";
import {
  decodeModelResponseFormatV1,
  STRUCTURED_OUTPUT_ISSUE_LIMIT_V1,
  type ModelResponseFormatV1,
  type ResponseFormatNoteV1,
  type StructuredOutputFailureV1,
} from "./structured-output.js";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolCallOccurrence {
  occurrenceId: string;
  /**
   * The occurrence this one was declared inside, for a call in a `batch`.
   * Absent for a call the model issued on its own. A sub-occurrence runs like
   * any other, but it is not one of the provider's own tool calls, so it is
   * not replayed back to the model as a tool message of its own.
   */
  parentOccurrenceId?: string;
  turn: number;
  step: number;
  ordinal: number;
  call: ToolCall;
}

export function toolOccurrenceId(
  turn: number,
  step: number,
  ordinal: number,
): string {
  if (
    !Number.isSafeInteger(turn) ||
    turn <= 0 ||
    !Number.isSafeInteger(step) ||
    step <= 0 ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    throw new Error("tool occurrence coordinates are invalid");
  }
  return `tool:${turn}:${step}:${ordinal}`;
}

export function toolCallOccurrences(
  turn: number,
  step: number,
  calls: readonly ToolCall[],
): ToolCallOccurrence[] {
  return calls.map((call, ordinal) => ({
    occurrenceId: toolOccurrenceId(turn, step, ordinal),
    turn,
    step,
    ordinal,
    call,
  }));
}

export function toolIntentMatches(
  call: ToolCall,
  intent: { name: string; input: unknown },
): boolean {
  if (call.name !== intent.name) return false;
  try {
    return JSON.stringify(call.input) === JSON.stringify(intent.input);
  } catch {
    return false;
  }
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The media types a tool result attachment may carry. */
export const TOOL_ATTACHMENT_MEDIA_TYPES_V1 = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type ToolAttachmentMediaTypeV1 =
  (typeof TOOL_ATTACHMENT_MEDIA_TYPES_V1)[number];

/** Most attachments one tool result may carry. */
export const TOOL_ATTACHMENT_LIMIT_V1 = 8;

/**
 * A binary a tool produced, named by where it lives durably rather than by its
 * bytes.
 *
 * The bytes are deliberately absent. An attachment is recorded in the session
 * event log, and that log is one Durable Object value: a base64 screenshot in
 * it would be a durable record that grows past what the object can hold. The
 * Workspace holds the bytes, the content hash names exactly which bytes, and a
 * model-invocation adapter that can show an image resolves them at request
 * time. `dataBase64` is that resolution and is never durable — the session
 * event decoder refuses it.
 */
export interface ToolAttachmentV1 {
  kind: "image";
  mediaType: ToolAttachmentMediaTypeV1;
  /** The durable root and relative path the bytes were written to. */
  workspacePath: WorkspacePathV1;
  contentHash: string;
  bytes: number;
  /** Resolved bytes, in memory only, for one model request. */
  dataBase64?: string;
}

/** Opaque response content needed to replay provider signatures after eviction. */
export interface ModelReplayStateV1 {
  connectionId?: string;
  connectionGeneration?: string;
  provider: string;
  model: string;
  content: string;
}

export function requireModelReplayStateV1(
  value: unknown,
  label = "model replay state",
): asserts value is ModelReplayStateV1 {
  const state = eventRecord(value, label);
  requireEventKeys(
    state,
    [
      "provider",
      "model",
      "content",
      ...(state.connectionId === undefined ? [] : ["connectionId"]),
      ...(state.connectionGeneration === undefined
        ? []
        : ["connectionGeneration"]),
    ],
    label,
  );
  if (state.connectionId !== undefined)
    eventString(state.connectionId, `${label}.connectionId`);
  if (state.connectionGeneration !== undefined)
    eventString(state.connectionGeneration, `${label}.connectionGeneration`);
  eventString(state.provider, `${label}.provider`);
  eventString(state.model, `${label}.model`);
  const content = eventString(state.content, `${label}.content`);
  if (content.length > 524_288)
    throw new Error(`${label}.content exceeds its limit`);
  requireJsonValue(JSON.parse(content), `${label}.content`);
}

export type LlmMessage =
  | {
      role: "user";
      content: string;
      /**
       * What the person attached. References in every durable place; the
       * bytes and text are filled in for one dispatch after the request is
       * journaled.
       */
      attachments?: MessageAttachmentV1[];
    }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      providerState?: ModelReplayStateV1;
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
      attachments?: ToolAttachmentV1[];
    };

export interface ModelBindingSnapshot {
  connectionId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

export interface NormalizedModelRequest {
  requestId: string;
  provider: string;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  responseFormat?: ModelResponseFormatV1;
  modelBinding?: ModelBindingSnapshot;
}

/** Provider-reported token accounting for one normalized model request. */
export interface LlmUsageV1 {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from a provider cache; included in `inputTokens`. */
  cachedInputTokens?: number;
  /** Reasoning tokens; included in `outputTokens`. */
  reasoningTokens?: number;
}

export type LlmStreamEvent =
  | { type: "provider-state"; state: ModelReplayStateV1 }
  | { type: "text-delta"; text: string }
  /**
   * A fragment of one tool call's argument text, while the model is still
   * writing it: `id` is the call's, `name` the tool as far as it is known, and
   * the fragments of one `id` concatenate to its JSON arguments so far. The
   * call still arrives whole as a `tool-call`, and that is the only thing the
   * loop acts on. A delta is a preview — nothing journals, replays or decides
   * on one — but it is output the model produced, so it counts as partial data.
   */
  | { type: "tool-input-delta"; id: string; name: string; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: LlmUsageV1 }
  | { type: "response-format-note"; note: ResponseFormatNoteV1 }
  | {
      type: "structured-output-failure";
      failure: StructuredOutputFailureV1;
    }
  | { type: "finish"; reason: "completed" | "tool-calls" | "max-tokens" };

export type StepOutcome =
  | "completed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "model-error"
  | "tool-error";

export type TurnOutcome = StepOutcome;

/** Longest `reason` a `turn/end` event may carry. */
export const TURN_END_REASON_MAX_LENGTH = 500;

/**
 * Bounds on one `conversation/compacted` event.
 *
 * A summary is model output that is stored durably and replayed into every
 * later request of the conversation, so it is bounded here rather than trusted
 * to be short: the whole point of compaction is that the window stops growing.
 */
export const COMPACTION_SUMMARY_MAX_LENGTH = 12_000;
export const COMPACTION_IDENTIFIERS_MAX = 200;
export const COMPACTION_IDENTIFIER_MAX_LENGTH = 400;
export const COMPACTION_FAILURE_REASON_MAX_LENGTH = 500;

/**
 * Spoken turns kept on one hang-up accordion. A longer call is clipped from
 * the tail: the opening greeting is less useful after hang-up than what was
 * just said.
 */
export const VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1 = 40;
export const VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1 = 2_000;

/** One spoken exchange on a hang-up accordion. */
export interface VoiceCallTranscriptTurnV1 {
  transcript: string;
  answer?: string;
}

/**
 * Truncates a failure description to what a `turn/end` `reason` accepts.
 * Returns `undefined` when nothing describable remains.
 */
export function turnEndReason(value: unknown): string | undefined {
  const text =
    value instanceof Error && value.message
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  const bounded = text.slice(0, TURN_END_REASON_MAX_LENGTH);
  return bounded.length > 0 ? bounded : undefined;
}

/**
 * The failure text recorded against a Turn that did not complete. It names the
 * outcome and the provider's own reason, which the debug surface and the API
 * both need. It is a diagnostic, not copy: the client never renders it into the
 * conversation — see `runFailureCopyV1` in the shell's client.
 */
export function turnFailureMessage(
  outcome: TurnOutcome,
  reason?: string,
): string {
  return reason
    ? `Bot turn ended with outcome ${outcome}: ${reason}`
    : `Bot turn ended with outcome ${outcome}`;
}

/**
 * The kind of Turn an Agent run was admitted as. GrokBot trims the tool
 * catalog per turn type — the parity register's row 57 — so the kernel has to
 * carry the value; which tools a turn type admits stays Package policy.
 *
 * All names are declared together because the value crosses the manifest, the
 * isolate contract, and the durable run record: adding one later is a wire
 * change in three places.
 */
export type TurnTypeV1 = "chat" | "agent" | "automation" | "subagent";

/** The declared turn types, in their canonical order. */
export const TURN_TYPES_V1: readonly TurnTypeV1[] = [
  "chat",
  "agent",
  "automation",
  "subagent",
];

/** The strict decoder for a turn type crossing any seam. */
export function decodeTurnTypeV1(
  value: unknown,
  label = "turn type",
): TurnTypeV1 {
  const turnType = TURN_TYPES_V1.find((candidate) => candidate === value);
  if (!turnType) throw new Error(`${label} is invalid`);
  return turnType;
}

/** The Composition generation an admitted Turn is pinned to. */
export interface CompositionPinV1 {
  generationId: string;
  artifactSetHash: string;
}

/**
 * The three Memory scopes a fact can be written to or injected from, named as
 * the session log records them. Bot Memory is the Bot's own, User Memory is
 * shared by all of the User's Bots, and a Group Chat's is shared by its
 * members.
 */
export type MemoryScopeNameV1 = "bot" | "user" | "group";

/**
 * Whole milliseconds one filed screenshot spent in each step. A step that did
 * not run is absent, so a capture that failed part-way still says where.
 */
export interface ComputerCaptureTimingV1 {
  screenshot?: number;
  write?: number;
  list?: number;
  prune?: number;
  total: number;
}

/**
 * Whole milliseconds one Computer call spent in each phase. A phase that did
 * not run is absent rather than zero. `total` also covers what no phase names,
 * such as closing the connection, so it can exceed the phases' sum.
 */
export interface ComputerTimingV1 {
  /** Opening the Computer for this Bot. */
  attach?: number;
  /** The durable-root sync: the pre-call pull or signal check, or the Turn-end push. */
  sync?: number;
  /** The Computer's self-check, which runs once per loaded Package. */
  selfCheck?: number;
  /**
   * The Computer calls the action itself made, without the records this
   * Package keeps around them; at Turn end, closing the Turn's preview tabs.
   */
  operation?: number;
  /**
   * The screenshot the call took: `computer_screenshot`'s own capture, or at
   * Turn end the card's frame, with the durable captures' retention when the
   * Turn filed one.
   */
  capture?: ComputerCaptureTimingV1;
  total: number;
}

export interface SessionEventMap {
  "session/created": { createdAt: string };
  /**
   * `skills` is the Skills this input invoked with `/` or `@`. Optional
   * because an input that invokes none carries no field at all, so every
   * `input/queued` recorded before invocation existed still decodes.
   */
  "input/queued": {
    messageId: string;
    text: string;
    skills?: SkillRefV1[];
    /** The files the person attached. Absent means none. */
    attachments?: MessageAttachmentV1[];
  };
  "input/admitted": { messageId: string; turn: number };
  "input/cancelled": { messageId: string; reason: "user" | "shutdown" };
  "turn/start": { turn: number };
  "composition/pinned": {
    turn: number;
    generationId: string;
    artifactSetHash: string;
  };
  /**
   * The turn type this Turn was admitted as, recorded beside the Composition
   * it pinned so the trimmed tool catalog the Turn ran on is auditable in
   * durable state. Absent on Turns recorded before turn admission existed;
   * they replay as `chat`.
   */
  "turn/admission": { turn: number; turnType: TurnTypeV1 };
  /**
   * A user-facing send, recorded on the step whose tool call produced it.
   * Row 57b: one send tool carries every typed payload, so the log holds the
   * payload rather than a per-payload event, and the client projection reads
   * it back. `occurrenceId` is the tool occurrence the send belongs to, which
   * is what makes a replayed Turn produce exactly one of these per call.
   */
  "send/to-user": {
    turn: number;
    step: number;
    occurrenceId: string;
    payload: SendToUserPayloadV1;
  };
  /**
   * The Turn's answer to whoever asked for it, when that was not the person
   * typing in this conversation.
   *
   * Its own event rather than a `send/to-user` with a flag, because the two
   * are genuinely different deliveries. A send is addressed to the User: it
   * mints a message, advances unread, and wakes a device. This is addressed to
   * the caller named on the Turn's admission — today the account's voice
   * session — which is reading it out itself. Routing one as the other is how
   * a person ends up badged for a sentence being spoken to them.
   *
   * It is still part of the conversation, and the transcript draws it: the
   * exchange happened in this Bot's thread and the person can read it back.
   */
  "reply/to-caller": {
    turn: number;
    step: number;
    occurrenceId: string;
    /** Who asked: the account's voice session, or another Bot of the User. */
    caller: "voice" | "bot";
    text: string;
  };
  /**
   * A child Turn's hand-off to its parent — the same Bot's user-visible
   * conversation (row 40, §2.13). Recorded here so the hand-off is durable on
   * the child's own log; delivering it to the parent is a later slice, and
   * nothing reads this event yet.
   */
  "wake/parent": {
    turn: number;
    step: number;
    occurrenceId: string;
    message: string;
  };
  "step/start": { turn: number; step: number };
  "user/message": {
    turn: number;
    step: number;
    messageId: string;
    text: string;
    /** References to what the person attached, never the bytes. */
    attachments?: MessageAttachmentV1[];
  };
  "model/request": {
    turn: number;
    step: number;
    request: NormalizedModelRequest;
  };
  /**
   * Bounded accounting for one model request. Providers report tokens when
   * they can; otherwise the loop estimates from the exact durable request and
   * response sizes. It deliberately carries no prompt or response content.
   */
  "model/usage": {
    turn: number;
    step: number;
    requestId: string;
    provider: string;
    model: string;
    modelBinding?: ModelBindingSnapshot;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    latencyMs: number;
    estimated: boolean;
  };
  /** One small durable explanation for why the next model attempt waited. */
  "model/retry": {
    turn: number;
    step: number;
    attempt: number;
    classification: "transient" | "permanent" | "unknown";
    delayMs: number;
  };
  "model/response-format-note": {
    turn: number;
    step: number;
    requestId: string;
    note: ResponseFormatNoteV1;
  };
  "model/response-failed": {
    turn: number;
    step: number;
    requestId: string;
    failure: StructuredOutputFailureV1;
  };
  "assistant/chunk": {
    turn: number;
    step: number;
    requestId: string;
    text: string;
  };
  "assistant/message": {
    turn: number;
    step: number;
    requestId: string;
    text: string;
    toolCalls: ToolCall[];
    providerState?: ModelReplayStateV1;
  };
  "tool/call": {
    turn: number;
    step: number;
    occurrenceId: string;
    name: string;
    input: unknown;
  };
  "tool/result": {
    turn: number;
    step: number;
    occurrenceId: string;
    name: string;
    content: string;
    isError: boolean;
    status: "completed" | "interrupted";
    /** Durable references to binaries the tool produced. Never their bytes. */
    attachments?: ToolAttachmentV1[];
  };
  /** A tool one loaded Package invoked through the Bot's shared registry. */
  "package/tool-call": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    callId: string;
    name: string;
    input: unknown;
  };
  /** The exact result returned to that Package. */
  "package/tool-result": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    callId: string;
    name: string;
    content: string;
    isError: boolean;
  };
  /**
   * One model call a Plugin made through the `ai` grant, in this Turn
   * (ADR 0026). The same accounting as `model/usage`, attributed to the
   * Plugin, and costed at the Bot's rate when the deployment bills, so the
   * Work view can itemise what each Plugin spent. Content never travels here.
   */
  "package/model-usage": {
    turn: number;
    step: number;
    packageId: string;
    requestId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    latencyMs: number;
    estimated: boolean;
    /** What the call cost the account, in micros; absent when unbilled. */
    costMicros?: number;
  };
  /**
   * The Bot recorded the intent to author a Package, before the bundler ran.
   * Constitution, Durable effects: intent is recorded before the effect.
   */
  "package/author-intent": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    sourceHash: string;
  };
  /** The authored artifact and the pending Composition generation it produced. */
  "package/authored": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    version: string;
    contentHash: string;
    generationId: string;
  };
  /**
   * A recorded Package effect intent that ended without its outcome: the host
   * refused, or the attempt threw. Every `package/*-intent` closes with either
   * its outcome event or this one, so the session log never says an effect was
   * intended and then falls silent about how it ended — which is exactly what
   * the intent/outcome pair is for (finding F12).
   */
  "package/effect-failed": {
    turn: number;
    step: number;
    effectId: string;
    effect: "author" | "undo";
    reason: string;
    /** The durable failure record, when the host wrote one. */
    failureId?: string;
  };
  /** A Bot-isolate loop hook failed open for one invocation. */
  "package/hook-failed": {
    packageId: string;
    event: string;
    generationId: string;
    message: string;
  };
  /** Durable intent before a Bot-origin Composition revert is proposed. */
  "package/undo-intent": {
    turn: number;
    step: number;
    effectId: string;
    requestedGenerationId?: string;
  };
  /** The new pending generation recorded by a Bot-origin revert. */
  "package/undo-recorded": {
    turn: number;
    step: number;
    effectId: string;
    generationId: string;
    targetGenerationId: string;
  };
  /**
   * The Skills this Turn loaded as instructions, and the candidates it
   * refused. Constitution, Memory: "the session event log records exactly what
   * was injected, so an injection gap is visible in durable state rather than
   * silently changing the Bot's behavior." A Skill is an instruction, so its
   * injection is recorded on the Turn that used it, with the exact generation
   * — "the exact Skill generation each Turn used is reconstructable".
   */
  "skill/injected": {
    turn: number;
    skills: Array<{
      path: string;
      name: string;
      generationId: string;
      contentHash: string;
      /**
       * Who the Skill is attributed to, when the reading Bot did not author
       * it: its User, or another Bot of that User writing the User-global
       * instruction root. Absent for a Skill the Bot wrote itself, which is
       * the common case and has nothing to disclose. It is rendered in the
       * catalog block, so the durable record and the prompt agree on whose
       * instruction the Turn ran under.
       */
      by?: string;
      /**
       * The references the Skill offered this Turn, with their generations
       * (ADR 0030). A Skill is a directory, and which files were beside it is
       * part of what was injected: a reference that was not there is then
       * visible in durable state rather than only in the body that named it.
       * Absent when the Skill offered none.
       */
      references?: Array<{
        path: string;
        /** Who wrote the reference, when it was not the reading Bot. */
        by?: string;
        generationId: string;
      }>;
    }>;
    refusals: Array<{ path: string; reason: string }>;
  };
  /**
   * A Skill the User invoked from the composer, resolved to the exact
   * generation this Turn expanded. Invocation is not disclosure-on-demand: the
   * body is expanded into the Turn's first step, so what the model was told is
   * reconstructable from `model/request` and *which* Skill the User asked for
   * is reconstructable from here. One event per invoked ref.
   */
  "skill/invoked": {
    turn: number;
    ref: SkillRefV1;
    generationId: string;
    contentHash: string;
  };
  /** The Bot recorded the intent to write a Skill, before the write ran. */
  "skill/write-intent": {
    turn: number;
    step: number;
    effectId: string;
    path: string;
    contentHash: string;
  };
  /** The generation the Skill write produced. */
  "skill/written": {
    turn: number;
    step: number;
    effectId: string;
    path: string;
    generationId: string;
    contentHash: string;
  };
  /**
   * The Memory this Turn injected, and what it left out. Constitution,
   * Memory: "What Memory enters a model request, and when, is Package policy,
   * and the session event log records exactly what was injected, so an
   * injection gap is visible in durable state rather than silently changing
   * the Bot's behavior." `sources` names every Memory file generation the
   * render read; `facts` is every line that reached the prompt; `omissions`
   * names each tier a cap or a failure cut short.
   *
   * `groupId` is `""` for the scopes that have none, so every entry has the
   * same shape and the decoder needs no optional field.
   */
  "memory/injected": {
    turn: number;
    sources: Array<{
      scope: MemoryScopeNameV1;
      groupId: string;
      path: string;
      generationId: string;
      contentHash: string;
    }>;
    facts: Array<{
      scope: MemoryScopeNameV1;
      groupId: string;
      /** The tier it was written as; a note lives in the log file. */
      tier: "profile" | "log" | "note";
      via: string;
      learnedAt: string;
      text: string;
    }>;
    omissions: Array<{ scope: MemoryScopeNameV1; reason: string }>;
    /**
     * Marked facts (`[note] `/`[episode] `) the note fade dropped before the
     * caps were applied, per scope. Deliberately distinct from `omissions`: an
     * omission is a gap to repair, a fade is the note tier working.
     */
    faded?: Array<{
      scope: MemoryScopeNameV1;
      groupId: string;
      count: number;
    }>;
    /**
     * `YYYY-MM-DD`: the oldest day a marked fact was still injected on, and
     * the TTL it was derived from. Recorded because the fade is read-time, so
     * the model request only reconstructs exactly if the day it used is on the
     * log. Absent on an event written before the fade existed, which is the
     * honest reading: no fade was applied.
     */
    noteCutoff?: string;
    noteTtlDays?: number;
  };
  /** The Bot recorded the intent to change Memory, before the write ran. */
  "memory/write-intent": {
    turn: number;
    step: number;
    effectId: string;
    action: "write" | "forget";
    scope: MemoryScopeNameV1;
    groupId: string;
    /**
     * `pending` when the intent cannot name a tier yet. A forget may rewrite
     * the profile file, one or more log files, or write a retraction, and
     * which it is, is not known until it has run; the `memory/written` events
     * that follow name the real tier and path.
     */
    tier: "profile" | "log" | "note" | "pending";
    /** Empty when the intent cannot name a path yet, for the same reason. */
    path: string;
    contentHash: string;
  };
  /** The generation the Memory write produced. */
  "memory/written": {
    turn: number;
    step: number;
    effectId: string;
    action: "write" | "forget";
    scope: MemoryScopeNameV1;
    groupId: string;
    tier: "profile" | "log" | "note";
    path: string;
    generationId: string;
    contentHash: string;
  };
  /**
   * The Bot recorded the intent to generate an image, before the model ran.
   *
   * "Record durable execution intent before invoking an external side effect.
   * Only effects an interface declares read-only are exempt." Image generation
   * is billed and durable, so the intent is recorded first and keyed by the
   * effect, which is also the object's name under the Package's Workspace
   * root. `promptHash` rather than the prompt: the prompt reaches the log once
   * already, in `tool/call`, and this event exists to fence the effect, not to
   * copy its input.
   */
  "image/generate-intent": {
    turn: number;
    step: number;
    effectId: string;
    model: string;
    promptHash: string;
    width: number;
    height: number;
  };
  /**
   * The generation the image write produced. Recorded after the Workspace
   * write settles, so recovery can tell an effect that reached storage from
   * one that did not, and never bills a second time for one that did.
   */
  "image/generated": {
    turn: number;
    step: number;
    effectId: string;
    model: string;
    path: string;
    generationId: string;
    contentHash: string;
    mimeType: string;
    width: number;
    height: number;
  };
  /**
   * A background process on the Computer changed hands: it was launched,
   * looked at, read, or ended. Recorded so a Turn's durable history says what
   * became of a process that outlived it — including `unknown`, which is a
   * first-class outcome and not an error.
   */
  "computer/process": {
    turn: number;
    processId: string;
    action: "launch" | "check" | "logs" | "stop";
    status: "starting" | "running" | "exited" | "unknown";
    exitCode?: number;
  };
  /**
   * Where one Computer call spent its time: `tool` for a Computer tool call,
   * named by `tool`, and `turn-end` for the capture and push after a Turn that
   * used the Computer. Diagnostic only; nothing reads it back.
   */
  "computer/timing": {
    turn: number;
    scope: "tool" | "turn-end";
    /** Present exactly when `scope` is `tool`. */
    tool?: string;
    ms: ComputerTimingV1;
  };
  /**
   * The dynamic Computer line this Turn added to its system prompt. An empty
   * `text` is an explicit wake-free read that found no fresh human lease; a
   * non-empty value records the exact line plus the durable lease generation
   * fields that selected it.
   */
  "computer/injected": {
    turn: number;
    text: string;
    ownerId?: string;
    expiresAt?: string;
  };
  /**
   * One run of the durable-root sync between the Computer's Workspace and
   * object storage, on a Turn that had the Computer open.
   *
   * "Connections to the Computer are expected to drop on every pause; every
   * Computer client reconnects and resumes rather than treating a dropped
   * connection as failure." A sync that could not run is therefore an
   * `unavailable` outcome recorded here, never a thrown error and never a
   * failed Turn — and a sync that did run leaves what it moved in durable
   * state, so a missing pull is visible rather than silent.
   *
   * `reason` is why the sync ran: `open` before the Turn's first Computer tool
   * call, `signal` when the on-Computer watcher reported a change mid-Turn,
   * and `turn-end` after a Turn that used the Computer.
   */
  "computer/sync": {
    turn: number;
    reason: "open" | "signal" | "turn-end";
    status: "ok" | "degraded" | "unavailable" | "refused" | "skipped";
    detail: string;
    pulled: number;
    pushed: number;
    restored: number;
    removed: number;
    adopted: number;
    /** Absent only on records written before bounded manifests shipped. */
    ignored?: number;
    /** Absent only on records written before bounded manifests shipped. */
    omitted?: number;
    conflicts: number;
    failures: number;
  };
  /**
   * The Bot's name changed, and who changed it. A rename is a durable write
   * that happens outside any Turn — a User edits the Bot's settings, or (from
   * the slice that gives a Bot its own profile tool) the Bot renames itself —
   * so the event carries no `turn` or `step`. `namedBy` is the writer the
   * durable profile now records, so the announcement and the provenance in
   * `BotProfile.namedBy` can never disagree.
   */
  "bot/renamed": {
    from: string;
    to: string;
    namedBy: "user" | "bot";
    /**
     * The Bot and admitted Turn that wrote the name, when a Bot wrote it.
     * `namedBy` says which kind of writer; this names the exact one, so a
     * self-rename is attributable from the log alone. Absent on a User rename
     * and on every announcement recorded before it existed.
     */
    writer?: {
      kind: "bot";
      botId: string;
      sessionId: string;
      turnId: string;
    };
  };
  /**
   * A subagent Task this Turn dispatched. Recorded on the *parent* Session,
   * because the child's Session is its own durable state and never enters the
   * visible transcript: this event is the only thing the conversation says
   * about a task, and the client draws it as a chip.
   *
   * `taskType` is an opaque string here for the same reason `turnType` is a
   * kernel value and a role catalog is not: which roles exist is Package
   * policy, and the kernel only records the one that was used.
   */
  "task/dispatched": {
    turn: number;
    step: number;
    occurrenceId: string;
    taskId: string;
    taskType: string;
    description: string;
    model: string;
    background: boolean;
  };
  /** A message the parent appended to a running task's bounded queue. */
  "task/message": {
    turn: number;
    step: number;
    occurrenceId: string;
    taskId: string;
    message: string;
  };
  /**
   * A task reached its one terminal state. It carries no `turn`: a background
   * task settles after the Turn that dispatched it is over, so this is durable
   * Bot history rather than a step of any Turn — the `bot/renamed` shape.
   */
  "task/settled": {
    taskId: string;
    status: "completed" | "failed" | "stopped";
    summary?: string;
  };
  /**
   * Explicit authenticated cancellation of a task, recorded before the child
   * is asked to stop. `requestedBy` says which door it came through: the Bot's
   * own `task_stop`, or the User's `POST /tasks/:taskId/stop`.
   */
  "task/stopped": {
    taskId: string;
    requestedBy: "bot" | "user";
  };
  /**
   * Spoken turns of one voice call, written when that call ends. It carries
   * no `turn`: hang-up is outside any Bot Turn, so this is the `bot/renamed`
   * shape — durable Bot history the thread draws as a collapsible section.
   *
   * `callId` is the idempotency key. A hang-up and the abandoned-call alarm
   * that follows a dropped socket must not write two sections for one call.
   */
  "voice/call": {
    callId: string;
    startedAt: string;
    endedAt: string;
    turns: VoiceCallTranscriptTurnV1[];
  };
  /**
   * The durable intent to compact this conversation, recorded before the
   * summariser model call it fences. It carries no `turn`: a compaction is
   * evaluated *after* a Turn has ended, so it belongs to the conversation
   * rather than to any step of it — the `bot/renamed` shape.
   *
   * `throughTurn` is the last Turn the attempt covers. A compaction always
   * covers a prefix, so the range is that one number, and it is also the
   * idempotency key: an intent is refused when a `conversation/compacted`
   * already covers it.
   */
  "conversation/compaction-intent": {
    effectId: string;
    throughTurn: number;
    provider: string;
    model: string;
  };
  /**
   * One summary of Turns `fromTurn` through `throughTurn`, computed once and
   * replayed on every later request. The newest such event supersedes every
   * earlier one, because each covers a prefix and the summariser folds the
   * previous summary into the range it extends.
   *
   * `identifiers` is the summariser's own "Identifiers mentioned" list, kept
   * as a field rather than left inside the prose: an opaque id that a summary
   * paraphrases produces a later tool call with a plausible-looking wrong
   * argument, so what the model was asked to preserve is what the log records.
   */
  "conversation/compacted": {
    effectId: string;
    fromTurn: number;
    throughTurn: number;
    summary: string;
    identifiers: string[];
    provider: string;
    model: string;
  };
  /**
   * A compaction intent that produced no summary — the summariser failed, ran
   * past its deadline, answered unusably, or a restart interrupted it. Never
   * fatal: the conversation carries on under the whole-Turn eviction that
   * already applies, and the next attempt is spaced by backoff counted from
   * these events.
   */
  "conversation/compaction-failed": {
    effectId: string;
    throughTurn: number;
    reason: string;
  };
  "step/end": { turn: number; step: number; outcome: StepOutcome };
  /**
   * `reason` states why a Turn ended in a non-`completed` outcome, so the
   * failure a User sees names its cause instead of only its outcome. It is
   * absent on a `completed` Turn and bounded to
   * {@link TURN_END_REASON_MAX_LENGTH} characters.
   */
  "turn/end": { turn: number; outcome: TurnOutcome; reason?: string };
  "session/disposed": { disposedAt: string };
}

function eventRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEventKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function eventString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function memoryScope(value: unknown, label: string): void {
  if (value !== "bot" && value !== "user" && value !== "group") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryTier(value: unknown, label: string): void {
  if (value !== "profile" && value !== "log" && value !== "note") {
    throw new Error(`${label} is invalid`);
  }
}

/**
 * The tier an *intent* names. A forget does not know which files it will
 * touch until it has run — it may rewrite the profile file, one or more log
 * files, or write a retraction — so `pending` is the honest answer, and the
 * `memory/written` events that follow name the real tier and path.
 */
function memoryIntentTier(value: unknown, label: string): void {
  if (value === "pending") return;
  memoryTier(value, label);
}

function memoryAction(value: unknown, label: string): void {
  if (value !== "write" && value !== "forget") {
    throw new Error(`${label} is invalid`);
  }
}

/** Exact keys, each a whole number of milliseconds; `total` is required. */
function requireTimingPhases(
  value: unknown,
  phases: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = eventRecord(value, label);
  requireEventKeys(
    record,
    ["total", ...phases.filter((phase) => Object.hasOwn(record, phase))],
    label,
  );
  for (const [phase, ms] of Object.entries(record)) {
    // `capture` holds its own steps, which the caller decodes.
    if (phase !== "capture") eventInteger(ms, `${label}.${phase}`, 0);
  }
  return record;
}

function requireComputerTiming(value: unknown): void {
  const label = "session event.ms";
  const timing = requireTimingPhases(
    value,
    ["attach", "sync", "selfCheck", "operation", "capture"],
    label,
  );
  if (timing.capture !== undefined) {
    requireTimingPhases(
      timing.capture,
      ["screenshot", "write", "list", "prune"],
      `${label}.capture`,
    );
  }
}

function requireVoiceCallTurns(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1
  ) {
    throw new Error("session event.turns must be a bounded array");
  }
  value.forEach((entry, index) => {
    const label = `session event.turns[${index}]`;
    const turn = eventRecord(entry, label);
    requireEventKeys(
      turn,
      Object.hasOwn(turn, "answer") ? ["transcript", "answer"] : ["transcript"],
      label,
    );
    const transcript = eventString(
      turn.transcript,
      `${label}.transcript`,
      true,
    );
    if (transcript.length > VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1) {
      throw new Error(`${label}.transcript is too long`);
    }
    if (turn.answer !== undefined) {
      const answer = eventString(turn.answer, `${label}.answer`, true);
      if (answer.length > VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1) {
        throw new Error(`${label}.answer is too long`);
      }
    }
  });
}

function eventTimestamp(value: unknown, label: string): string {
  const timestamp = eventString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return timestamp;
}

function eventInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer`);
  }
  return value as number;
}

function requireJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) requireJsonValue(entry, label, depth + 1);
    return;
  }
  const record = eventRecord(value, label);
  for (const entry of Object.values(record)) {
    requireJsonValue(entry, label, depth + 1);
  }
}

function requireToolCall(value: unknown, label: string): void {
  const call = eventRecord(value, label);
  requireEventKeys(call, ["id", "name", "input"], label);
  eventString(call.id, `${label}.id`);
  eventString(call.name, `${label}.name`);
  requireJsonValue(call.input, `${label}.input`);
}

function requireLlmMessage(value: unknown, label: string): void {
  const message = eventRecord(value, label);
  const role = eventString(message.role, `${label}.role`);
  if (role === "user") {
    requireEventKeys(
      message,
      [
        "role",
        "content",
        ...(Object.hasOwn(message, "attachments") ? ["attachments"] : []),
      ],
      label,
    );
    eventString(message.content, `${label}.content`, true);
    if (message.attachments !== undefined) {
      decodeMessageAttachmentsV1(
        message.attachments,
        `${label}.attachments`,
        false,
      );
    }
    return;
  }
  if (role === "assistant") {
    requireEventKeys(
      message,
      [
        "role",
        "content",
        "toolCalls",
        ...(message.providerState === undefined ? [] : ["providerState"]),
      ],
      label,
    );
    if (message.providerState !== undefined)
      requireModelReplayStateV1(
        message.providerState,
        `${label}.providerState`,
      );
    eventString(message.content, `${label}.content`, true);
    if (!Array.isArray(message.toolCalls)) {
      throw new Error(`${label}.toolCalls must be an array`);
    }
    message.toolCalls.forEach((call, index) =>
      requireToolCall(call, `${label}.toolCalls[${index}]`),
    );
    return;
  }
  if (role === "tool") {
    requireEventKeys(
      message,
      [
        "role",
        "callId",
        "name",
        "content",
        "isError",
        ...(Object.hasOwn(message, "attachments") ? ["attachments"] : []),
      ],
      label,
    );
    if (message.attachments !== undefined) {
      decodeToolAttachmentsV1(
        message.attachments,
        `${label}.attachments`,
        false,
      );
    }
    eventString(message.callId, `${label}.callId`);
    eventString(message.name, `${label}.name`);
    eventString(message.content, `${label}.content`, true);
    if (typeof message.isError !== "boolean") {
      throw new Error(`${label}.isError must be a boolean`);
    }
    return;
  }
  throw new Error(`${label}.role is invalid`);
}

/**
 * The exact v1 decoder for the attachments a tool result carries.
 *
 * `durable` refuses `dataBase64`: resolved bytes belong to one model request
 * and never to the event log, so a record that carries them is a record that
 * would grow without bound and is rejected at the seam rather than trimmed.
 */
export function decodeToolAttachmentsV1(
  value: unknown,
  label: string,
  durable: boolean,
): ToolAttachmentV1[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > TOOL_ATTACHMENT_LIMIT_V1) {
    throw new Error(
      `${label} must hold at most ${TOOL_ATTACHMENT_LIMIT_V1} attachments`,
    );
  }
  return value.map((entry, index) => {
    const item = `${label}[${index}]`;
    const attachment = eventRecord(entry, item);
    requireEventKeys(
      attachment,
      [
        "kind",
        "mediaType",
        "workspacePath",
        "contentHash",
        "bytes",
        ...(Object.hasOwn(attachment, "dataBase64") ? ["dataBase64"] : []),
      ],
      item,
    );
    if (attachment.kind !== "image") {
      throw new Error(`${item}.kind is invalid`);
    }
    const mediaType = TOOL_ATTACHMENT_MEDIA_TYPES_V1.find(
      (known) => known === attachment.mediaType,
    );
    if (!mediaType) throw new Error(`${item}.mediaType is invalid`);
    if (
      typeof attachment.bytes !== "number" ||
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0
    ) {
      throw new Error(`${item}.bytes must be a non-negative integer`);
    }
    const contentHash = eventString(
      attachment.contentHash,
      `${item}.contentHash`,
    );
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new Error(`${item}.contentHash must be a sha-256 digest`);
    }
    if (durable && attachment.dataBase64 !== undefined) {
      throw new Error(
        `${item}.dataBase64 is never durable; the Workspace holds the bytes`,
      );
    }
    return {
      kind: "image",
      mediaType,
      workspacePath: decodeWorkspacePathV1(
        attachment.workspacePath,
        `${item}.workspacePath`,
      ),
      contentHash,
      bytes: attachment.bytes,
      ...(attachment.dataBase64 === undefined
        ? {}
        : {
            dataBase64: eventString(
              attachment.dataBase64,
              `${item}.dataBase64`,
            ),
          }),
    } satisfies ToolAttachmentV1;
  });
}

function requireToolSchema(value: unknown, label: string): void {
  const tool = eventRecord(value, label);
  requireEventKeys(tool, ["name", "description", "inputSchema"], label);
  eventString(tool.name, `${label}.name`);
  eventString(tool.description, `${label}.description`, true);
  const schema = eventRecord(tool.inputSchema, `${label}.inputSchema`);
  requireJsonValue(schema, `${label}.inputSchema`);
}

function requireStructuredOutputFailureV1(value: unknown, label: string): void {
  const failure = eventRecord(value, label);
  if (failure.code === "invalid-json") {
    requireEventKeys(failure, ["code", "message"], label);
    eventString(failure.message, `${label}.message`);
    return;
  }
  if (failure.code !== "schema-mismatch") {
    throw new Error(`${label}.code is invalid`);
  }
  requireEventKeys(failure, ["code", "message", "issues"], label);
  eventString(failure.message, `${label}.message`);
  if (!Array.isArray(failure.issues)) {
    throw new Error(`${label}.issues must be an array`);
  }
  if (failure.issues.length > STRUCTURED_OUTPUT_ISSUE_LIMIT_V1) {
    throw new Error(`${label}.issues exceeds its limit`);
  }
  for (const [index, candidate] of failure.issues.entries()) {
    const issue = eventRecord(candidate, `${label}.issues[${index}]`);
    requireEventKeys(
      issue,
      ["path", "code", "message"],
      `${label}.issues[${index}]`,
    );
    eventString(issue.path, `${label}.issues[${index}].path`);
    eventString(issue.message, `${label}.issues[${index}].message`);
    if (
      issue.code !== "type" &&
      issue.code !== "enum" &&
      issue.code !== "required" &&
      issue.code !== "additional-property"
    ) {
      throw new Error(`${label}.issues[${index}].code is invalid`);
    }
  }
}

/**
 * The exact v1 decoder for one normalized stream event.
 *
 * Exported because the event crosses a seam inbound: a model provider Plugin
 * answers with the same normalized vocabulary the kernel would have decoded
 * from a Package, and every inbound value is decoded where it crosses.
 */
export function decodeLlmStreamEventV1(
  value: unknown,
  label = "llm stream event",
): LlmStreamEvent {
  const event = eventRecord(value, label);
  const type = eventString(event.type, `${label}.type`);
  switch (type) {
    case "provider-state":
      requireEventKeys(event, ["type", "state"], label);
      requireModelReplayStateV1(event.state, `${label}.state`);
      break;
    case "text-delta":
      requireEventKeys(event, ["type", "text"], label);
      // A delta may be empty: a provider that streams a tool call only still
      // opens with a delta event carrying no text.
      eventString(event.text, `${label}.text`, true);
      break;
    case "tool-input-delta":
      requireEventKeys(event, ["type", "id", "name", "delta"], label);
      eventString(event.id, `${label}.id`);
      eventString(event.name, `${label}.name`);
      eventString(event.delta, `${label}.delta`, true);
      break;
    case "tool-call":
      requireEventKeys(event, ["type", "call"], label);
      requireToolCall(event.call, `${label}.call`);
      break;
    case "usage": {
      requireEventKeys(event, ["type", "usage"], label);
      const usage = eventRecord(event.usage, `${label}.usage`);
      requireEventKeys(
        usage,
        [
          "inputTokens",
          "outputTokens",
          ...(Object.hasOwn(usage, "cachedInputTokens")
            ? ["cachedInputTokens"]
            : []),
          ...(Object.hasOwn(usage, "reasoningTokens")
            ? ["reasoningTokens"]
            : []),
        ],
        `${label}.usage`,
      );
      const inputTokens = eventInteger(
        usage.inputTokens,
        `${label}.usage.inputTokens`,
        0,
      );
      const outputTokens = eventInteger(
        usage.outputTokens,
        `${label}.usage.outputTokens`,
        0,
      );
      if (usage.cachedInputTokens !== undefined) {
        const cached = eventInteger(
          usage.cachedInputTokens,
          `${label}.usage.cachedInputTokens`,
          0,
        );
        if (cached > inputTokens) {
          throw new Error(
            `${label}.usage.cachedInputTokens exceeds inputTokens`,
          );
        }
      }
      if (usage.reasoningTokens !== undefined) {
        const reasoning = eventInteger(
          usage.reasoningTokens,
          `${label}.usage.reasoningTokens`,
          0,
        );
        if (reasoning > outputTokens) {
          throw new Error(
            `${label}.usage.reasoningTokens exceeds outputTokens`,
          );
        }
      }
      break;
    }
    case "response-format-note": {
      requireEventKeys(event, ["type", "note"], label);
      const note = eventRecord(event.note, `${label}.note`);
      requireEventKeys(
        note,
        ["code", "requested", "effective", "message"],
        `${label}.note`,
      );
      if (note.code !== "structured-output-downgraded") {
        throw new Error(`${label}.note.code is invalid`);
      }
      if (note.requested !== "json_schema" && note.requested !== "json") {
        throw new Error(`${label}.note.requested is invalid`);
      }
      if (note.effective !== "json" && note.effective !== "prompt") {
        throw new Error(`${label}.note.effective is invalid`);
      }
      eventString(note.message, `${label}.note.message`);
      break;
    }
    case "structured-output-failure":
      requireEventKeys(event, ["type", "failure"], label);
      requireStructuredOutputFailureV1(event.failure, `${label}.failure`);
      break;
    case "finish":
      requireEventKeys(event, ["type", "reason"], label);
      if (
        event.reason !== "completed" &&
        event.reason !== "tool-calls" &&
        event.reason !== "max-tokens"
      ) {
        throw new Error(`${label}.reason is invalid`);
      }
      break;
    default:
      throw new Error(`${label}.type is invalid`);
  }
  // SAFETY: the switch validated every variant's fields exactly.
  return event as unknown as LlmStreamEvent;
}

/**
 * The exact v1 decoder for a normalized model request. Exported because the
 * request crosses the Bot isolate boundary inbound — a Bot-authored model
 * adapter composes it — and every inbound value is decoded at its seam.
 */
export function decodeNormalizedModelRequestV1(
  value: unknown,
  label = "normalized model request",
): NormalizedModelRequest {
  requireNormalizedModelRequest(value, label);
  // SAFETY: requireNormalizedModelRequest validated every field exactly.
  return value as NormalizedModelRequest;
}

function requireNormalizedModelRequest(value: unknown, label: string): void {
  const request = eventRecord(value, label);
  requireEventKeys(
    request,
    [
      "requestId",
      "provider",
      "model",
      "system",
      "messages",
      "tools",
      ...(Object.hasOwn(request, "responseFormat") ? ["responseFormat"] : []),
      ...(Object.hasOwn(request, "modelBinding") ? ["modelBinding"] : []),
    ],
    label,
  );
  eventString(request.requestId, `${label}.requestId`);
  eventString(request.provider, `${label}.provider`);
  eventString(request.model, `${label}.model`);
  eventString(request.system, `${label}.system`, true);
  if (!Array.isArray(request.messages) || !Array.isArray(request.tools)) {
    throw new Error(`${label} messages and tools must be arrays`);
  }
  request.messages.forEach((message, index) =>
    requireLlmMessage(message, `${label}.messages[${index}]`),
  );
  request.tools.forEach((tool, index) =>
    requireToolSchema(tool, `${label}.tools[${index}]`),
  );
  if (request.responseFormat !== undefined) {
    decodeModelResponseFormatV1(
      request.responseFormat,
      `${label}.responseFormat`,
    );
  }
  if (request.modelBinding !== undefined) {
    const binding = eventRecord(request.modelBinding, `${label}.modelBinding`);
    requireEventKeys(
      binding,
      [
        "connectionId",
        ...(Object.hasOwn(binding, "connectionGeneration")
          ? ["connectionGeneration"]
          : []),
        ...(Object.hasOwn(binding, "catalogGeneration")
          ? ["catalogGeneration"]
          : []),
      ],
      `${label}.modelBinding`,
    );
    eventString(binding.connectionId, `${label}.modelBinding.connectionId`);
    if (binding.connectionGeneration !== undefined) {
      eventString(
        binding.connectionGeneration,
        `${label}.modelBinding.connectionGeneration`,
      );
    }
    if (binding.catalogGeneration !== undefined) {
      eventString(
        binding.catalogGeneration,
        `${label}.modelBinding.catalogGeneration`,
      );
    }
  }
}

const SESSION_EVENT_COMMON_KEYS = ["type", "seq", "timestamp"] as const;

export function decodeSessionEvent(input: unknown): SessionEvent {
  const event = eventRecord(input, "session event");
  const type = eventString(event.type, "session event.type");
  eventInteger(event.seq, "session event.seq", 0);
  eventTimestamp(event.timestamp, "session event.timestamp");
  const keys = (...specific: string[]) => [
    ...SESSION_EVENT_COMMON_KEYS,
    ...specific,
  ];
  const turn = () => eventInteger(event.turn, "session event.turn", 1);
  const step = () => eventInteger(event.step, "session event.step", 1);
  const text = () => eventString(event.text, "session event.text", true);
  const requestId = () =>
    eventString(event.requestId, "session event.requestId");
  switch (type) {
    case "session/created":
      requireEventKeys(event, keys("createdAt"), "session event");
      eventTimestamp(event.createdAt, "session event.createdAt");
      break;
    case "input/queued":
      // Exact keys either way: an input that invoked no Skill carries no
      // `skills` field, and one that did carries a bounded, decoded list. The
      // same holds for attachments.
      requireEventKeys(
        event,
        keys(
          "messageId",
          "text",
          ...(event.skills === undefined ? [] : ["skills"]),
          ...(event.attachments === undefined ? [] : ["attachments"]),
        ),
        "session event",
      );
      eventString(event.messageId, "session event.messageId");
      text();
      if (event.skills !== undefined) {
        decodeSkillRefsV1(event.skills, "session event.skills");
      }
      if (event.attachments !== undefined) {
        decodeMessageAttachmentsV1(
          event.attachments,
          "session event.attachments",
          true,
        );
      }
      break;
    case "input/admitted":
      requireEventKeys(event, keys("messageId", "turn"), "session event");
      eventString(event.messageId, "session event.messageId");
      turn();
      break;
    case "input/cancelled":
      requireEventKeys(event, keys("messageId", "reason"), "session event");
      eventString(event.messageId, "session event.messageId");
      if (event.reason !== "user" && event.reason !== "shutdown") {
        throw new Error("session event.reason is invalid");
      }
      break;
    case "turn/start":
      requireEventKeys(event, keys("turn"), "session event");
      turn();
      break;
    case "composition/pinned":
      requireEventKeys(
        event,
        keys("turn", "generationId", "artifactSetHash"),
        "session event",
      );
      turn();
      eventString(event.generationId, "session event.generationId");
      eventString(event.artifactSetHash, "session event.artifactSetHash");
      break;
    case "turn/admission":
      requireEventKeys(event, keys("turn", "turnType"), "session event");
      turn();
      decodeTurnTypeV1(event.turnType, "session event.turnType");
      break;
    case "send/to-user":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "payload"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      // A send already on the log: the reserved Card namespace is refused
      // where a payload is authored, not where one is read back.
      decodeSendToUserPayloadV1(event.payload, "session event.payload", {
        kernelMinted: true,
      });
      break;
    case "reply/to-caller":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "caller", "text"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      if (event.caller !== "voice" && event.caller !== "bot") {
        throw new Error("session event.caller is invalid");
      }
      eventString(event.text, "session event.text");
      break;
    case "wake/parent":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "message"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.message, "session event.message");
      break;
    case "step/start":
      requireEventKeys(event, keys("turn", "step"), "session event");
      turn();
      step();
      break;
    case "user/message":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "messageId",
          "text",
          ...(event.attachments === undefined ? [] : ["attachments"]),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.messageId, "session event.messageId");
      text();
      if (event.attachments !== undefined) {
        decodeMessageAttachmentsV1(
          event.attachments,
          "session event.attachments",
          true,
        );
      }
      break;
    case "model/request":
      requireEventKeys(event, keys("turn", "step", "request"), "session event");
      turn();
      step();
      requireNormalizedModelRequest(event.request, "session event.request");
      break;
    case "model/usage": {
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "requestId",
          "provider",
          "model",
          ...(Object.hasOwn(event, "modelBinding") ? ["modelBinding"] : []),
          "inputTokens",
          "outputTokens",
          ...(Object.hasOwn(event, "cachedInputTokens")
            ? ["cachedInputTokens"]
            : []),
          ...(Object.hasOwn(event, "reasoningTokens")
            ? ["reasoningTokens"]
            : []),
          "latencyMs",
          "estimated",
        ),
        "session event",
      );
      turn();
      step();
      requestId();
      eventString(event.provider, "session event.provider");
      eventString(event.model, "session event.model");
      if (event.modelBinding !== undefined) {
        requireNormalizedModelRequest(
          {
            requestId: event.requestId,
            provider: event.provider,
            model: event.model,
            system: "",
            messages: [],
            tools: [],
            modelBinding: event.modelBinding,
          },
          "session event usage binding",
        );
      }
      const inputTokens = eventInteger(
        event.inputTokens,
        "session event.inputTokens",
        0,
      );
      const outputTokens = eventInteger(
        event.outputTokens,
        "session event.outputTokens",
        0,
      );
      if (event.cachedInputTokens !== undefined) {
        const cached = eventInteger(
          event.cachedInputTokens,
          "session event.cachedInputTokens",
          0,
        );
        if (cached > inputTokens) {
          throw new Error(
            "session event.cachedInputTokens cannot exceed inputTokens",
          );
        }
      }
      if (event.reasoningTokens !== undefined) {
        const reasoning = eventInteger(
          event.reasoningTokens,
          "session event.reasoningTokens",
          0,
        );
        if (reasoning > outputTokens) {
          throw new Error(
            "session event.reasoningTokens cannot exceed outputTokens",
          );
        }
      }
      eventInteger(event.latencyMs, "session event.latencyMs", 0);
      if (typeof event.estimated !== "boolean") {
        throw new Error("session event.estimated must be a boolean");
      }
      break;
    }
    case "model/response-format-note": {
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "note"),
        "session event",
      );
      turn();
      step();
      requestId();
      const note = eventRecord(event.note, "session event.note");
      requireEventKeys(
        note,
        keys("code", "requested", "effective", "message"),
        "session event.note",
      );
      if (note.code !== "structured-output-downgraded") {
        throw new Error("session event.note.code is invalid");
      }
      if (note.requested !== "json_schema" && note.requested !== "json") {
        throw new Error("session event.note.requested is invalid");
      }
      if (note.effective !== "json" && note.effective !== "prompt") {
        throw new Error("session event.note.effective is invalid");
      }
      eventString(note.message, "session event.note.message");
      break;
    }
    case "model/response-failed": {
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "failure"),
        "session event",
      );
      turn();
      step();
      requestId();
      requireStructuredOutputFailureV1(event.failure, "session event.failure");
      break;
    }
    case "model/retry":
      requireEventKeys(
        event,
        keys("turn", "step", "attempt", "classification", "delayMs"),
        "session event",
      );
      turn();
      step();
      eventInteger(event.attempt, "session event.attempt", 2);
      if (
        event.classification !== "transient" &&
        event.classification !== "permanent" &&
        event.classification !== "unknown"
      ) {
        throw new Error("session event.classification is invalid");
      }
      eventInteger(event.delayMs, "session event.delayMs", 0);
      break;
    case "assistant/chunk":
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "text"),
        "session event",
      );
      turn();
      step();
      requestId();
      text();
      break;
    case "assistant/message":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "requestId",
          "text",
          "toolCalls",
          ...(event.providerState === undefined ? [] : ["providerState"]),
        ),
        "session event",
      );
      turn();
      step();
      requestId();
      text();
      if (event.providerState !== undefined)
        requireModelReplayStateV1(event.providerState);
      if (!Array.isArray(event.toolCalls)) {
        throw new Error("session event.toolCalls must be an array");
      }
      event.toolCalls.forEach((call, index) =>
        requireToolCall(call, `session event.toolCalls[${index}]`),
      );
      break;
    case "tool/call":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "name", "input"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.name, "session event.name");
      requireJsonValue(event.input, "session event.input");
      break;
    case "tool/result":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "occurrenceId",
          "name",
          "content",
          "isError",
          "status",
          ...(Object.hasOwn(event, "attachments") ? ["attachments"] : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.name, "session event.name");
      eventString(event.content, "session event.content", true);
      if (typeof event.isError !== "boolean") {
        throw new Error("session event.isError must be a boolean");
      }
      if (event.status !== "completed" && event.status !== "interrupted") {
        throw new Error("session event.status is invalid");
      }
      if (event.attachments !== undefined) {
        decodeToolAttachmentsV1(
          event.attachments,
          "session event.attachments",
          true,
        );
      }
      break;
    case "package/tool-call":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "packageId",
          "callId",
          "name",
          "input",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.callId, "session event.callId");
      eventString(event.name, "session event.name");
      requireJsonValue(event.input, "session event.input");
      break;
    case "package/tool-result":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "packageId",
          "callId",
          "name",
          "content",
          "isError",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.callId, "session event.callId");
      eventString(event.name, "session event.name");
      eventString(event.content, "session event.content", true);
      if (typeof event.isError !== "boolean") {
        throw new Error("session event.isError must be a boolean");
      }
      break;
    case "package/model-usage": {
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "packageId",
          "requestId",
          "provider",
          "model",
          "inputTokens",
          "outputTokens",
          ...(Object.hasOwn(event, "cachedInputTokens")
            ? ["cachedInputTokens"]
            : []),
          ...(Object.hasOwn(event, "reasoningTokens")
            ? ["reasoningTokens"]
            : []),
          "latencyMs",
          "estimated",
          ...(Object.hasOwn(event, "costMicros") ? ["costMicros"] : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.packageId, "session event.packageId");
      requestId();
      eventString(event.provider, "session event.provider");
      eventString(event.model, "session event.model");
      const inputTokens = eventInteger(
        event.inputTokens,
        "session event.inputTokens",
        0,
      );
      const outputTokens = eventInteger(
        event.outputTokens,
        "session event.outputTokens",
        0,
      );
      if (event.cachedInputTokens !== undefined) {
        const cached = eventInteger(
          event.cachedInputTokens,
          "session event.cachedInputTokens",
          0,
        );
        if (cached > inputTokens) {
          throw new Error(
            "session event.cachedInputTokens cannot exceed inputTokens",
          );
        }
      }
      if (event.reasoningTokens !== undefined) {
        const reasoning = eventInteger(
          event.reasoningTokens,
          "session event.reasoningTokens",
          0,
        );
        if (reasoning > outputTokens) {
          throw new Error(
            "session event.reasoningTokens cannot exceed outputTokens",
          );
        }
      }
      eventInteger(event.latencyMs, "session event.latencyMs", 0);
      if (typeof event.estimated !== "boolean") {
        throw new Error("session event.estimated must be a boolean");
      }
      if (event.costMicros !== undefined) {
        eventInteger(event.costMicros, "session event.costMicros", 0);
      }
      break;
    }
    case "package/author-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "packageId", "sourceHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.sourceHash, "session event.sourceHash");
      break;
    case "package/authored":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "packageId",
          "version",
          "contentHash",
          "generationId",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.version, "session event.version");
      eventString(event.contentHash, "session event.contentHash");
      eventString(event.generationId, "session event.generationId");
      break;
    case "package/effect-failed":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "effect",
          "reason",
          ...(Object.hasOwn(event, "failureId") ? ["failureId"] : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      if (event.effect !== "author" && event.effect !== "undo") {
        throw new Error('session event.effect must be "author" or "undo"');
      }
      eventString(event.reason, "session event.reason", true);
      if (Object.hasOwn(event, "failureId")) {
        eventString(event.failureId, "session event.failureId");
      }
      break;
    case "package/hook-failed":
      requireEventKeys(
        event,
        keys("packageId", "event", "generationId", "message"),
        "session event",
      );
      eventString(event.packageId, "session event.packageId");
      eventString(event.event, "session event.event");
      eventString(event.generationId, "session event.generationId");
      eventString(event.message, "session event.message");
      break;
    case "package/undo-intent":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          ...(Object.hasOwn(event, "requestedGenerationId")
            ? ["requestedGenerationId"]
            : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      if (event.requestedGenerationId !== undefined) {
        eventString(
          event.requestedGenerationId,
          "session event.requestedGenerationId",
        );
      }
      break;
    case "package/undo-recorded":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "generationId", "targetGenerationId"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.generationId, "session event.generationId");
      eventString(event.targetGenerationId, "session event.targetGenerationId");
      break;
    case "skill/injected": {
      requireEventKeys(
        event,
        keys("turn", "skills", "refusals"),
        "session event",
      );
      turn();
      if (!Array.isArray(event.skills) || !Array.isArray(event.refusals)) {
        throw new Error("session event skills and refusals must be arrays");
      }
      event.skills.forEach((skill, index) => {
        const label = `session event.skills[${index}]`;
        const entry = eventRecord(skill, label);
        // Exact keys either way: a Skill the Bot wrote itself carries no `by`,
        // and one written by its User or another of its User's Bots carries
        // the attribution the catalog block renders. A Skill with no files
        // beside it carries no `references` for the same reason.
        requireEventKeys(
          entry,
          [
            "path",
            "name",
            "generationId",
            "contentHash",
            ...(entry.by === undefined ? [] : ["by"]),
            ...(entry.references === undefined ? [] : ["references"]),
          ],
          label,
        );
        eventString(entry.path, `${label}.path`);
        eventString(entry.name, `${label}.name`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
        if (entry.by !== undefined) eventString(entry.by, `${label}.by`);
        if (entry.references !== undefined) {
          if (!Array.isArray(entry.references)) {
            throw new Error(`${label}.references must be an array`);
          }
          entry.references.forEach((reference, position) => {
            const referenceLabel = `${label}.references[${position}]`;
            const listed = eventRecord(reference, referenceLabel);
            requireEventKeys(
              listed,
              [
                "path",
                ...(listed.by === undefined ? [] : ["by"]),
                "generationId",
              ],
              referenceLabel,
            );
            eventString(listed.path, `${referenceLabel}.path`);
            if (listed.by !== undefined) {
              eventString(listed.by, `${referenceLabel}.by`);
            }
            eventString(listed.generationId, `${referenceLabel}.generationId`);
          });
        }
      });
      event.refusals.forEach((refusal, index) => {
        const label = `session event.refusals[${index}]`;
        const entry = eventRecord(refusal, label);
        requireEventKeys(entry, ["path", "reason"], label);
        // A refusal that names no path is still a refusal — the read was
        // declined at the root, and the reason is the part that matters.
        // Rejecting it here killed the Turn *after* the event was appended,
        // which left the durable log open inside that Turn and wedged the Bot.
        eventString(entry.path, `${label}.path`, true);
        eventString(entry.reason, `${label}.reason`);
      });
      break;
    }
    case "skill/invoked":
      requireEventKeys(
        event,
        keys("turn", "ref", "generationId", "contentHash"),
        "session event",
      );
      turn();
      decodeSkillRefV1(event.ref, "session event.ref");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "skill/write-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "path", "contentHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.path, "session event.path");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "skill/written":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "path", "generationId", "contentHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/injected": {
      requireEventKeys(
        event,
        keys(
          "turn",
          "sources",
          "facts",
          "omissions",
          // The fade's bookkeeping arrived after the event did, so a session
          // logged before it still decodes: absent means no fade ran.
          ...(Object.hasOwn(event, "faded") ? ["faded"] : []),
          ...(Object.hasOwn(event, "noteCutoff") ? ["noteCutoff"] : []),
          ...(Object.hasOwn(event, "noteTtlDays") ? ["noteTtlDays"] : []),
        ),
        "session event",
      );
      turn();
      if (
        !Array.isArray(event.sources) ||
        !Array.isArray(event.facts) ||
        !Array.isArray(event.omissions)
      ) {
        throw new Error(
          "session event sources, facts and omissions must be arrays",
        );
      }
      event.sources.forEach((source, index) => {
        const label = `session event.sources[${index}]`;
        const entry = eventRecord(source, label);
        requireEventKeys(
          entry,
          ["scope", "groupId", "path", "generationId", "contentHash"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.groupId, `${label}.groupId`, true);
        eventString(entry.path, `${label}.path`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
      });
      event.facts.forEach((fact, index) => {
        const label = `session event.facts[${index}]`;
        const entry = eventRecord(fact, label);
        requireEventKeys(
          entry,
          ["scope", "groupId", "tier", "via", "learnedAt", "text"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.groupId, `${label}.groupId`, true);
        // `note` too: a note lives in the log file, and recording it as `log`
        // left a reader of the durable event unable to tell the tiers apart.
        memoryTier(entry.tier, `${label}.tier`);
        eventString(entry.via, `${label}.via`, true);
        eventString(entry.learnedAt, `${label}.learnedAt`);
        eventString(entry.text, `${label}.text`);
      });
      event.omissions.forEach((omission, index) => {
        const label = `session event.omissions[${index}]`;
        const entry = eventRecord(omission, label);
        requireEventKeys(entry, ["scope", "reason"], label);
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.reason, `${label}.reason`);
      });
      if (Object.hasOwn(event, "faded")) {
        if (!Array.isArray(event.faded)) {
          throw new Error("session event faded must be an array");
        }
        event.faded.forEach((fade, index) => {
          const label = `session event.faded[${index}]`;
          const entry = eventRecord(fade, label);
          requireEventKeys(entry, ["scope", "groupId", "count"], label);
          memoryScope(entry.scope, `${label}.scope`);
          eventString(entry.groupId, `${label}.groupId`, true);
          eventInteger(entry.count, `${label}.count`, 1);
        });
      }
      if (Object.hasOwn(event, "noteCutoff")) {
        eventString(event.noteCutoff, "session event.noteCutoff");
      }
      if (Object.hasOwn(event, "noteTtlDays")) {
        eventInteger(event.noteTtlDays, "session event.noteTtlDays", 1);
      }
      break;
    }
    case "memory/write-intent":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          "scope",
          "groupId",
          "tier",
          "path",
          "contentHash",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryAction(event.action, "session event.action");
      memoryScope(event.scope, "session event.scope");
      eventString(event.groupId, "session event.groupId", true);
      memoryIntentTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path", true);
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/written":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          "scope",
          "groupId",
          "tier",
          "path",
          "generationId",
          "contentHash",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryAction(event.action, "session event.action");
      memoryScope(event.scope, "session event.scope");
      eventString(event.groupId, "session event.groupId", true);
      memoryTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "image/generate-intent":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "model",
          "promptHash",
          "width",
          "height",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.model, "session event.model");
      eventString(event.promptHash, "session event.promptHash");
      eventInteger(event.width, "session event.width", 1);
      eventInteger(event.height, "session event.height", 1);
      break;
    case "image/generated":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "model",
          "path",
          "generationId",
          "contentHash",
          "mimeType",
          "width",
          "height",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.model, "session event.model");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      eventString(event.mimeType, "session event.mimeType");
      eventInteger(event.width, "session event.width", 1);
      eventInteger(event.height, "session event.height", 1);
      break;
    case "task/dispatched":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "occurrenceId",
          "taskId",
          "taskType",
          "description",
          "model",
          "background",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.taskId, "session event.taskId");
      eventString(event.taskType, "session event.taskType");
      eventString(event.description, "session event.description");
      eventString(event.model, "session event.model");
      if (typeof event.background !== "boolean") {
        throw new Error("session event.background must be a boolean");
      }
      break;
    case "task/message":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "taskId", "message"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.taskId, "session event.taskId");
      eventString(event.message, "session event.message");
      break;
    case "task/settled":
      requireEventKeys(
        event,
        keys(
          "taskId",
          "status",
          ...(Object.hasOwn(event, "summary") ? ["summary"] : []),
        ),
        "session event",
      );
      eventString(event.taskId, "session event.taskId");
      if (
        event.status !== "completed" &&
        event.status !== "failed" &&
        event.status !== "stopped"
      ) {
        throw new Error("session event.status is invalid");
      }
      if (event.summary !== undefined) {
        eventString(event.summary, "session event.summary");
      }
      break;
    case "task/stopped":
      requireEventKeys(event, keys("taskId", "requestedBy"), "session event");
      eventString(event.taskId, "session event.taskId");
      if (event.requestedBy !== "bot" && event.requestedBy !== "user") {
        throw new Error("session event.requestedBy is invalid");
      }
      break;
    case "voice/call":
      requireEventKeys(
        event,
        keys("callId", "startedAt", "endedAt", "turns"),
        "session event",
      );
      eventString(event.callId, "session event.callId");
      eventTimestamp(event.startedAt, "session event.startedAt");
      eventTimestamp(event.endedAt, "session event.endedAt");
      requireVoiceCallTurns(event.turns);
      break;
    case "computer/process": {
      requireEventKeys(
        event,
        keys(
          "turn",
          "processId",
          "action",
          "status",
          ...(Object.hasOwn(event, "exitCode") ? ["exitCode"] : []),
        ),
        "session event",
      );
      turn();
      eventString(event.processId, "session event.processId");
      if (
        event.action !== "launch" &&
        event.action !== "check" &&
        event.action !== "logs" &&
        event.action !== "stop"
      ) {
        throw new Error("session event.action is invalid");
      }
      if (
        event.status !== "starting" &&
        event.status !== "running" &&
        event.status !== "exited" &&
        event.status !== "unknown"
      ) {
        throw new Error("session event.status is invalid");
      }
      if (
        event.exitCode !== undefined &&
        (typeof event.exitCode !== "number" ||
          !Number.isSafeInteger(event.exitCode))
      ) {
        throw new Error("session event.exitCode must be an integer");
      }
      break;
    }
    case "computer/timing": {
      const tool = event.scope === "tool";
      requireEventKeys(
        event,
        keys("turn", "scope", ...(tool ? ["tool"] : []), "ms"),
        "session event",
      );
      turn();
      if (!tool && event.scope !== "turn-end") {
        throw new Error("session event.scope is invalid");
      }
      if (tool) eventString(event.tool, "session event.tool");
      requireComputerTiming(event.ms);
      break;
    }
    case "computer/injected": {
      const active = event.text !== "";
      requireEventKeys(
        event,
        keys("turn", "text", ...(active ? ["ownerId", "expiresAt"] : [])),
        "session event",
      );
      turn();
      eventString(event.text, "session event.text", true);
      if (active) {
        eventString(event.ownerId, "session event.ownerId");
        eventTimestamp(event.expiresAt, "session event.expiresAt");
      }
      break;
    }
    case "computer/sync": {
      requireEventKeys(
        event,
        keys(
          "turn",
          "reason",
          "status",
          "detail",
          "pulled",
          "pushed",
          "restored",
          "removed",
          "adopted",
          ...(Object.hasOwn(event, "ignored") ? ["ignored"] : []),
          ...(Object.hasOwn(event, "omitted") ? ["omitted"] : []),
          "conflicts",
          "failures",
        ),
        "session event",
      );
      turn();
      if (!["open", "signal", "turn-end"].includes(event.reason as string)) {
        throw new Error("session event.reason is invalid");
      }
      if (
        !["ok", "degraded", "unavailable", "refused", "skipped"].includes(
          event.status as string,
        )
      ) {
        throw new Error("session event.status is invalid");
      }
      eventString(event.detail, "session event.detail", true);
      for (const field of [
        "pulled",
        "pushed",
        "restored",
        "removed",
        "adopted",
        "conflicts",
        "failures",
      ] as const) {
        eventInteger(event[field], `session event.${field}`, 0);
      }
      if (event.ignored !== undefined) {
        eventInteger(event.ignored, "session event.ignored", 0);
      }
      if (event.omitted !== undefined) {
        eventInteger(event.omitted, "session event.omitted", 0);
      }
      break;
    }
    case "bot/renamed": {
      requireEventKeys(
        event,
        keys(
          "from",
          "to",
          "namedBy",
          ...(Object.hasOwn(event, "writer") ? ["writer"] : []),
        ),
        "session event",
      );
      eventString(event.from, "session event.from");
      eventString(event.to, "session event.to");
      if (event.namedBy !== "user" && event.namedBy !== "bot") {
        throw new Error("session event.namedBy is invalid");
      }
      if (event.writer !== undefined) {
        const writer = event.writer;
        if (
          typeof writer !== "object" ||
          writer === null ||
          Array.isArray(writer)
        ) {
          throw new Error("session event.writer is invalid");
        }
        const fields = writer as Record<string, unknown>;
        requireEventKeys(
          fields,
          ["kind", "botId", "sessionId", "turnId"],
          "session event.writer",
        );
        if (fields.kind !== "bot") {
          throw new Error("session event.writer.kind is invalid");
        }
        eventString(fields.botId, "session event.writer.botId");
        eventString(fields.sessionId, "session event.writer.sessionId");
        eventString(fields.turnId, "session event.writer.turnId");
        // Only a Bot writer exists, so a `user` provenance can never carry one.
        if (event.namedBy !== "bot") {
          throw new Error("session event.writer is invalid");
        }
      }
      break;
    }
    case "conversation/compaction-intent":
      requireEventKeys(
        event,
        keys("effectId", "throughTurn", "provider", "model"),
        "session event",
      );
      eventString(event.effectId, "session event.effectId");
      eventInteger(event.throughTurn, "session event.throughTurn", 1);
      eventString(event.provider, "session event.provider");
      eventString(event.model, "session event.model");
      break;
    case "conversation/compacted": {
      requireEventKeys(
        event,
        keys(
          "effectId",
          "fromTurn",
          "throughTurn",
          "summary",
          "identifiers",
          "provider",
          "model",
        ),
        "session event",
      );
      eventString(event.effectId, "session event.effectId");
      const fromTurn = eventInteger(
        event.fromTurn,
        "session event.fromTurn",
        1,
      );
      const throughTurn = eventInteger(
        event.throughTurn,
        "session event.throughTurn",
        1,
      );
      if (throughTurn < fromTurn) {
        throw new Error("session event.throughTurn is invalid");
      }
      const summary = eventString(event.summary, "session event.summary");
      if (summary.length > COMPACTION_SUMMARY_MAX_LENGTH) {
        throw new Error("session event.summary is too long");
      }
      if (
        !Array.isArray(event.identifiers) ||
        event.identifiers.length > COMPACTION_IDENTIFIERS_MAX
      ) {
        throw new Error("session event.identifiers must be a bounded array");
      }
      event.identifiers.forEach((identifier, index) => {
        const label = `session event.identifiers[${index}]`;
        if (
          eventString(identifier, label).length >
          COMPACTION_IDENTIFIER_MAX_LENGTH
        ) {
          throw new Error(`${label} is too long`);
        }
      });
      eventString(event.provider, "session event.provider");
      eventString(event.model, "session event.model");
      break;
    }
    case "conversation/compaction-failed": {
      requireEventKeys(
        event,
        keys("effectId", "throughTurn", "reason"),
        "session event",
      );
      eventString(event.effectId, "session event.effectId");
      eventInteger(event.throughTurn, "session event.throughTurn", 1);
      const reason = eventString(event.reason, "session event.reason");
      if (reason.length > COMPACTION_FAILURE_REASON_MAX_LENGTH) {
        throw new Error("session event.reason is too long");
      }
      break;
    }
    case "step/end":
      requireEventKeys(event, keys("turn", "step", "outcome"), "session event");
      turn();
      step();
      if (
        ![
          "completed",
          "blocked",
          "cancelled",
          "interrupted",
          "model-error",
          "tool-error",
        ].includes(event.outcome as string)
      ) {
        throw new Error("session event.outcome is invalid");
      }
      break;
    case "turn/end":
      requireEventKeys(
        event,
        keys(
          "turn",
          "outcome",
          ...(Object.hasOwn(event, "reason") ? ["reason"] : []),
        ),
        "session event",
      );
      turn();
      if (event.reason !== undefined) {
        const reason = eventString(event.reason, "session event.reason");
        if (reason.length > TURN_END_REASON_MAX_LENGTH) {
          throw new Error("session event.reason is too long");
        }
      }
      if (
        ![
          "completed",
          "blocked",
          "cancelled",
          "interrupted",
          "model-error",
          "tool-error",
        ].includes(event.outcome as string)
      ) {
        throw new Error("session event.outcome is invalid");
      }
      break;
    case "session/disposed":
      requireEventKeys(event, keys("disposedAt"), "session event");
      eventTimestamp(event.disposedAt, "session event.disposedAt");
      break;
    default:
      throw new Error("session event.type is invalid");
  }
  // SAFETY: the exhaustive variant switch validates every SessionEvent field.
  return event as unknown as SessionEvent;
}

export type SessionEventInput<
  T extends keyof SessionEventMap = keyof SessionEventMap,
> = {
  [K in T]: { type: K } & SessionEventMap[K];
}[T];

export type SessionEvent<
  T extends keyof SessionEventMap = keyof SessionEventMap,
> = SessionEventInput<T> & {
  seq: number;
  timestamp: string;
};

export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
}
