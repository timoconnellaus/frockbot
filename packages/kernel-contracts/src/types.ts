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

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolCallOccurrence {
  occurrenceId: string;
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

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
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
  modelBinding?: ModelBindingSnapshot;
}

export type LlmStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
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

/** The failure text a User sees for a Turn that did not complete. */
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
export type TurnTypeV1 = "chat" | "automation" | "subagent";

/** The declared turn types, in their canonical order. */
export const TURN_TYPES_V1: readonly TurnTypeV1[] = [
  "chat",
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
 * The three Memory tiers a fact can be written to or injected from, named as
 * the session log records them. Bot Memory is the Bot's own; the other two are
 * shared roots sharded per writing Bot.
 */
export type MemoryScopeNameV1 = "bot" | "user" | "project";

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
  };
  "model/request": {
    turn: number;
    step: number;
    request: NormalizedModelRequest;
  };
  "model/effect-not-started": {
    turn: number;
    step: number;
    requestId: string;
    reason: string;
  };
  "model/reconciliation-required": {
    turn: number;
    step: number;
    requestId: string;
    reason: string;
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
  /** A Bot-isolate loop hook failed open for one invocation. */
  "package/hook-failed": {
    packageId: string;
    event: string;
    generationId: string;
    message: string;
  };
  /** Durable session intent before a Catalog installation effect. */
  "package/catalog-change-intent": {
    turn: number;
    step: number;
    effectId: string;
    action: "install" | "update" | "remove";
    catalogId?: string;
    packageId?: string;
    contentHash?: string;
  };
  /** The pending Composition generation produced by that Catalog change. */
  "package/catalog-changed": {
    turn: number;
    step: number;
    effectId: string;
    action: "install" | "update" | "remove";
    packageId: string;
    contentHash?: string;
    generationId: string;
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
   * `projectId` is `""` for the tiers that have none, so every entry has the
   * same shape and the decoder needs no optional field.
   */
  "memory/injected": {
    turn: number;
    sources: Array<{
      scope: MemoryScopeNameV1;
      projectId: string;
      path: string;
      generationId: string;
      contentHash: string;
    }>;
    facts: Array<{
      scope: MemoryScopeNameV1;
      projectId: string;
      tier: "profile" | "log";
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
      projectId: string;
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
    projectId: string;
    tier: "profile" | "log" | "note";
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
    projectId: string;
    tier: "profile" | "log" | "note";
    path: string;
    generationId: string;
    contentHash: string;
  };
  /** The Bot recorded the intent to change Project membership, before it ran. */
  "memory/project-intent": {
    turn: number;
    step: number;
    effectId: string;
    action: "create" | "join" | "leave";
    projectId: string;
  };
  /** The Project membership the durable authority holds after the change. */
  "memory/project-changed": {
    turn: number;
    step: number;
    effectId: string;
    action: "create" | "join" | "leave";
    projectId: string;
    projects: string[];
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
   * One run of the durable-root sync between the Computer's Workspace and
   * object storage (ADR 0013), on a Turn that had the Computer open.
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
   * `turn-end` after a Turn that used the Computer.
   */
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
  "computer/sync": {
    turn: number;
    reason: "open" | "signal" | "turn-end";
    status: "ok" | "unavailable" | "refused" | "skipped";
    detail: string;
    pulled: number;
    pushed: number;
    restored: number;
    removed: number;
    adopted: number;
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
   * A subagent Task this Turn dispatched (ADR 0017). Recorded on the *parent*
   * Session, because the child's Session is its own durable state and never
   * enters the visible transcript: this event is the only thing the
   * conversation says about a task, and the client draws it as a chip.
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
  if (value !== "bot" && value !== "user" && value !== "project") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryTier(value: unknown, label: string): void {
  if (value !== "profile" && value !== "log" && value !== "note") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryAction(value: unknown, label: string): void {
  if (value !== "write" && value !== "forget") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryProjectAction(value: unknown, label: string): void {
  if (value !== "create" && value !== "join" && value !== "leave") {
    throw new Error(`${label} is invalid`);
  }
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
    requireEventKeys(message, ["role", "content"], label);
    eventString(message.content, `${label}.content`, true);
    return;
  }
  if (role === "assistant") {
    requireEventKeys(message, ["role", "content", "toolCalls"], label);
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
      // `skills` field, and one that did carries a bounded, decoded list.
      requireEventKeys(
        event,
        event.skills === undefined
          ? keys("messageId", "text")
          : keys("messageId", "text", "skills"),
        "session event",
      );
      eventString(event.messageId, "session event.messageId");
      text();
      if (event.skills !== undefined) {
        decodeSkillRefsV1(event.skills, "session event.skills");
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
      decodeSendToUserPayloadV1(event.payload, "session event.payload");
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
        keys("turn", "step", "messageId", "text"),
        "session event",
      );
      turn();
      step();
      eventString(event.messageId, "session event.messageId");
      text();
      break;
    case "model/request":
      requireEventKeys(event, keys("turn", "step", "request"), "session event");
      turn();
      step();
      requireNormalizedModelRequest(event.request, "session event.request");
      break;
    case "model/effect-not-started":
    case "model/reconciliation-required":
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "reason"),
        "session event",
      );
      turn();
      step();
      requestId();
      eventString(event.reason, "session event.reason");
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
        keys("turn", "step", "requestId", "text", "toolCalls"),
        "session event",
      );
      turn();
      step();
      requestId();
      text();
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
    case "package/catalog-change-intent":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          ...(Object.hasOwn(event, "catalogId") ? ["catalogId"] : []),
          ...(Object.hasOwn(event, "packageId") ? ["packageId"] : []),
          ...(Object.hasOwn(event, "contentHash") ? ["contentHash"] : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      if (
        event.action !== "install" &&
        event.action !== "update" &&
        event.action !== "remove"
      ) {
        throw new Error("session event.action is invalid");
      }
      if (event.catalogId !== undefined)
        eventString(event.catalogId, "session event.catalogId");
      if (event.packageId !== undefined)
        eventString(event.packageId, "session event.packageId");
      if (event.contentHash !== undefined)
        eventString(event.contentHash, "session event.contentHash");
      if (
        (event.action === "remove" &&
          (event.packageId === undefined ||
            event.catalogId !== undefined ||
            event.contentHash !== undefined)) ||
        (event.action !== "remove" &&
          (event.catalogId === undefined ||
            event.contentHash === undefined ||
            event.packageId !== undefined))
      ) {
        throw new Error("session Catalog change intent identity is invalid");
      }
      break;
    case "package/catalog-changed":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          "packageId",
          "generationId",
          ...(Object.hasOwn(event, "contentHash") ? ["contentHash"] : []),
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.generationId, "session event.generationId");
      if (event.contentHash !== undefined)
        eventString(event.contentHash, "session event.contentHash");
      if (
        event.action !== "install" &&
        event.action !== "update" &&
        event.action !== "remove"
      ) {
        throw new Error("session event.action is invalid");
      }
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
        // the attribution the catalog block renders.
        requireEventKeys(
          entry,
          entry.by === undefined
            ? ["path", "name", "generationId", "contentHash"]
            : ["path", "name", "generationId", "contentHash", "by"],
          label,
        );
        eventString(entry.path, `${label}.path`);
        eventString(entry.name, `${label}.name`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
        if (entry.by !== undefined) eventString(entry.by, `${label}.by`);
      });
      event.refusals.forEach((refusal, index) => {
        const label = `session event.refusals[${index}]`;
        const entry = eventRecord(refusal, label);
        requireEventKeys(entry, ["path", "reason"], label);
        eventString(entry.path, `${label}.path`);
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
          ["scope", "projectId", "path", "generationId", "contentHash"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.projectId, `${label}.projectId`, true);
        eventString(entry.path, `${label}.path`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
      });
      event.facts.forEach((fact, index) => {
        const label = `session event.facts[${index}]`;
        const entry = eventRecord(fact, label);
        requireEventKeys(
          entry,
          ["scope", "projectId", "tier", "via", "learnedAt", "text"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.projectId, `${label}.projectId`, true);
        if (entry.tier !== "profile" && entry.tier !== "log") {
          throw new Error(`${label}.tier is invalid`);
        }
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
          requireEventKeys(entry, ["scope", "projectId", "count"], label);
          memoryScope(entry.scope, `${label}.scope`);
          eventString(entry.projectId, `${label}.projectId`, true);
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
          "projectId",
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
      eventString(event.projectId, "session event.projectId", true);
      memoryTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path");
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
          "projectId",
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
      eventString(event.projectId, "session event.projectId", true);
      memoryTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/project-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "action", "projectId"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryProjectAction(event.action, "session event.action");
      eventString(event.projectId, "session event.projectId");
      break;
    case "memory/project-changed":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "action", "projectId", "projects"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryProjectAction(event.action, "session event.action");
      eventString(event.projectId, "session event.projectId");
      if (!Array.isArray(event.projects)) {
        throw new Error("session event.projects must be an array");
      }
      event.projects.forEach((project, index) =>
        eventString(project, `session event.projects[${index}]`),
      );
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
        !["ok", "unavailable", "refused", "skipped"].includes(
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
