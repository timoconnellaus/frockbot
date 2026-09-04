import {
  decodeSendToUserPayloadV1,
  decodeSkillRefsV1,
  type SendToUserPayloadV1,
  type SessionEvent,
  type SkillRefV1,
} from "@frockbot/kernel-contracts";
import {
  isPublicIdentifier,
  isRpcIdentifier,
} from "@frockbot/configuration-core";
import { decodeRunCursorV1, RUN_CURSOR_PATTERN } from "./run-cursor.js";
export { decodeRunCursorV1, RUN_CURSOR_PATTERN };
import type {
  ClientNotificationIntent,
  ClientRun,
  ClientTurnEvent,
  ClientTurnResponse,
} from "@frockbot/client-core";
import {
  decodeRunIdV1,
  requireStoredRunV1,
  type BotNotificationIntent,
  type BotTurnCompletion,
  type StoredRun,
} from "./backend-contracts.js";
import { runFailureCopyV1 } from "./run-failure-copy.js";

const MAX_RUN_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_INPUT_BYTES = 32_000;
const MAX_OUTCOME_BYTES = 64_000;
const MAX_FAILURE_BYTES = 8_000;
const MAX_VISIBLE_EVENTS = 512;
const MAX_EVENT_ID_LENGTH = 256;
const MAX_EVENT_NAME_BYTES = 256;
const MAX_EVENT_CONTENT_BYTES = 32_000;
const MAX_VISIBLE_EVENT_BYTES = 128_000;
const MAX_NOTIFICATION_TITLE_BYTES = 512;
const MAX_NOTIFICATION_BODY_BYTES = 2_000;
const MAX_CLIENT_TURN_BYTES = 256_000;
const MAX_CURSOR_LENGTH = 320;
/** A conversation is named by its Session id, which the kernel bounds. */
const MAX_SESSION_ID_LENGTH = 320;
const MAX_TASK_DESCRIPTION_BYTES = 800;
const MAX_TASK_MODEL_BYTES = 512;
export const CLIENT_RUN_PAGE_LIMIT = 32;
export const CLIENT_RUN_LIST_MAX_BYTES = 512_000;

export type ClientRunStatusV1 =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "reconciliation-required";

// Both are sentences for the person, not descriptions of the mechanism: the
// wire outcome is what a client with no copy of its own renders verbatim, and
// "Stopped by an authenticated Stop command" told somebody who pressed Stop
// about the authentication of their own button press.
const CANCELLED_RUN_MESSAGE = "You stopped this.";
const SUPERSEDED_RUN_MESSAGE = "Interrupted by your next message.";
/** What a Turn waiting on a person's "Try again" says while it waits. */
export const RESUMABLE_RUN_MESSAGE_V1 =
  "This reply stopped partway. Try again to continue it.";

/**
 * Why the Bot declined to admit a Turn. A refusal is an ordinary answer — the
 * Bot is busy with a Turn this command did not ask to replace, is holding an
 * effect only a User can settle, or the command was fenced or already used —
 * so the client shows the reason and keeps the person's text rather than
 * treating it as a failure of the send.
 */
export type ClientTurnRefusalReasonV1 =
  "busy" | "reconciliation-required" | "fenced" | "duplicate";

/** The versioned body a refused Turn answers with, decoded by the client. */
export interface ClientTurnRefusalV1 {
  schemaVersion: 1;
  status: "refused";
  reason: ClientTurnRefusalReasonV1;
  error: string;
}

const TURN_REFUSAL_REASONS_V1: readonly ClientTurnRefusalReasonV1[] = [
  "busy",
  "reconciliation-required",
  "fenced",
  "duplicate",
];

/** The refusal a response body carries, or `undefined` when it carries none. */
export function decodeClientTurnRefusalV1(
  value: unknown,
): ClientTurnRefusalV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  if (body.schemaVersion !== 1 || body.status !== "refused") return undefined;
  if (typeof body.error !== "string") return undefined;
  const reason = TURN_REFUSAL_REASONS_V1.find(
    (candidate) => candidate === body.reason,
  );
  if (!reason) return undefined;
  return {
    schemaVersion: 1,
    status: "refused",
    reason,
    error: wireString(body, "error", MAX_FAILURE_BYTES, "turn refusal"),
  };
}

/**
 * A refusal, as an error, because that is how a transport reports a non-2xx.
 * The reason survives on the error so the client can tell "the Bot said no"
 * from "the send may or may not have happened".
 */
export class ClientTurnRefusedErrorV1 extends Error {
  constructor(readonly refusal: ClientTurnRefusalV1) {
    super(refusal.error);
    this.name = "ClientTurnRefusedErrorV1";
  }
}

export type ClientRunEventV1 =
  | {
      type: "run/events-truncated";
      omittedInteractions: number;
    }
  | {
      type: "tool/call";
      call: {
        id: string;
        name: string;
        input?: ClientDynamicToolCallInputV1;
      };
    }
  | {
      type: "tool/result";
      callId: string;
      content: string;
      isError: boolean;
      /**
       * Binaries the tool filed in a durable root. References, never bytes:
       * the client fetches them from the Workspace read route, so a thread
       * that scrolls past a hundred screenshots carries a hundred paths.
       */
      attachments?: ClientToolAttachmentV1[];
    }
  /**
   * A user-facing send, projected so the client can draw the payload. The
   * Turn's derived text carries only what the model wrote as an assistant
   * message, and a widget-ended Turn writes none, so the payload has to reach
   * the client here or not at all.
   */
  | {
      type: "send/to-user";
      payload: SendToUserPayloadV1;
    }
  /**
   * A child Turn's hand-off to its parent. Projected because it is durable
   * history of that Turn; delivering it into the parent is a later slice.
   */
  | {
      type: "wake/parent";
      message: string;
    }
  | {
      type: "computer/sync";
      status: "degraded" | "unavailable" | "refused" | "skipped";
      message: string;
    }
  /**
   * A subagent this Turn dispatched (ADR 0017). The child's Session never
   * enters the visible transcript, so this chip is the whole of what the
   * conversation says about it: what it is, what it was asked to do, and which
   * model it runs on. Its *live* status and its summary come from the Bot's
   * task list, not from here — this event is the durable fact that the dispatch
   * happened, and it never changes after it is written.
   */
  | {
      type: "task/dispatched";
      taskId: string;
      taskType: string;
      description: string;
      model: string;
      background: boolean;
    };

/** The bounded, public identity needed to present a dynamic tool call. */
export interface ClientDynamicToolCallInputV1 {
  namespace: string;
  toolName: string;
  /** JSON keeps this cross-runtime DTO shallow while preserving tool input. */
  argumentsJson?: string;
}

export type ClientRunOutcomeV1 =
  | { type: "completed"; text: string }
  /**
   * A Turn that broke keeps what it had already said, for the same reason a
   * stopped one does: the words arrived, the person read them, and replacing
   * them with a notice would rewrite what they watched happen (ADR 0028).
   */
  | { type: "failed"; message: string; text?: string }
  /**
   * A Turn a Stop or a later message ended keeps what it had already said:
   * `text` is that partial answer, and `message` is the line saying why it
   * ends where it does (ADR 0024).
   */
  | { type: "cancelled"; message: string; text?: string }
  | { type: "superseded"; message: string; text?: string };

export interface ClientRunRecoveryV1 {
  action: "resume";
  message: string;
}

/**
 * The run projection. Version 2 added structured `send/to-user` and
 * `wake/parent` events; version 3 adds the bounded `via` marker for agent and
 * Voice Turns without exposing the internal origin record.
 */
export interface ClientRunV1 {
  schemaVersion: 1 | 2 | 3;
  runId: string;
  admittedAt: string;
  input: string;
  status: ClientRunStatusV1;
  events: ClientRunEventV1[];
  /** Durable Stop intent, projected independently of the run status. */
  stopRequestedAt?: string;
  /**
   * True while the Turn is admitted and waiting rather than running. The
   * thread draws it as an ordinary message the Bot has not reached yet, and
   * the flag is durable state, so a reload draws the same thing.
   */
  queued?: true;
  /**
   * The answer the Bot has written so far, present only while the run is still
   * running and has produced text. The thread draws it in the bubble it is
   * already drawing for the Turn, so a reply appears as it is written instead
   * of arriving whole at settlement. A settled run carries its answer in
   * `outcome` instead, and never both.
   */
  partialText?: string;
  outcome?: ClientRunOutcomeV1;
  recovery?: ClientRunRecoveryV1;
  /** Where an agent-lane question entered this Bot's transcript. */
  via?:
    | { kind: "bot"; name: string; botId: string }
    | { kind: "voice"; name: "Voice" };
}

export interface ClientRunPageV1 {
  truncated: boolean;
  nextCursor?: string;
}

/**
 * A durable Session event that belongs to no Turn. The WebUI renders it as a
 * system line in the conversation.
 */
/**
 * A session-level line in the transcript that belongs to neither party.
 *
 * `conversation/compacted` is ADR 0030's one user-visible surface: the earlier
 * Turns are still there and still readable, and this says plainly that the
 * model now carries a summary of them instead of the Turns themselves. ADR
 * 0027's "not summarised" notice still stands where Turns were genuinely
 * evicted, so the two never claim each other's ground.
 */
export type ClientAnnouncementV1 =
  | {
      type: "bot/renamed";
      announcementId: string;
      at: string;
      from: string;
      to: string;
      namedBy: "user" | "bot";
    }
  | {
      type: "conversation/compacted";
      announcementId: string;
      at: string;
      throughTurn: number;
    };

export interface ClientRunListV1 {
  schemaVersion: 1;
  runs: ClientRunV1[];
  page: ClientRunPageV1;
  /**
   * Optional so a stored projection written before announcements existed still
   * decodes. Absent means the same as an empty list.
   */
  announcements?: ClientAnnouncementV1[];
}

/**
 * One conversation a Bot has had.
 *
 * A Bot holds one conversation at a time and keeps the ones before it: the
 * transcript shows the current one, and an earlier one is still readable.
 */
export interface ClientConversationV1 {
  schemaVersion: 1;
  /** The Session id this conversation's Turns recorded. */
  conversationId: string;
  ordinal: number;
  startedAt: string;
  /** Absent while this is the conversation the Bot is on. */
  endedAt?: string;
}

export interface ClientConversationListV1 {
  schemaVersion: 1;
  /** Newest first; the first entry is the conversation the Bot is on. */
  conversations: ClientConversationV1[];
}

/**
 * The answer to "start a new conversation": the list, or the reason not now.
 *
 * A refusal is a value, not an exception. The request crosses a Durable Object
 * boundary and a Worker boundary to get here, and an exception that crosses
 * either is logged by workerd as `Uncaught Error` — the log then showed the
 * isolate going down with a broken pipe behind it. Carrying the refusal as
 * data means the only thing that reaches the client is the 409 it expects.
 */
export type ClientConversationOutcomeV1 =
  | ({ status: "started" } & ClientConversationListV1)
  | { status: "refused"; schemaVersion: 1; reason: string };

export function decodeClientConversationListV1(
  input: unknown,
): ClientConversationListV1 {
  const list = record(input, "conversation list");
  exactKeys(list, ["schemaVersion", "conversations"], "conversation list");
  if (list.schemaVersion !== 1) {
    throw new Error("conversation list.schemaVersion is invalid");
  }
  if (!Array.isArray(list.conversations)) {
    throw new Error("conversation list.conversations is invalid");
  }
  return {
    schemaVersion: 1,
    conversations: list.conversations.map((entry) => {
      const conversation = record(entry, "conversation");
      exactKeys(
        conversation,
        ["schemaVersion", "conversationId", "ordinal", "startedAt", "endedAt"],
        "conversation",
      );
      if (conversation.schemaVersion !== 1) {
        throw new Error("conversation.schemaVersion is invalid");
      }
      if (
        typeof conversation.ordinal !== "number" ||
        !Number.isSafeInteger(conversation.ordinal) ||
        conversation.ordinal < 1
      ) {
        throw new Error("conversation.ordinal is invalid");
      }
      return {
        schemaVersion: 1 as const,
        conversationId: string(
          conversation,
          "conversationId",
          MAX_SESSION_ID_LENGTH,
          "conversation",
        ),
        ordinal: conversation.ordinal,
        startedAt: string(conversation, "startedAt", 64, "conversation"),
        ...(conversation.endedAt === undefined
          ? {}
          : { endedAt: string(conversation, "endedAt", 64, "conversation") }),
      };
    }),
  };
}

export interface ClientRunListQueryV1 {
  schemaVersion: 1;
  before?: string;
  /**
   * The conversation to read. Absent means the one the Bot is on now, which
   * is what the transcript shows; an earlier conversation is named by the
   * Session id `listConversations` gave for it.
   */
  conversationId?: string;
}

export interface ClientTurnCommandV1 {
  schemaVersion: 1;
  commandId: string;
  text: string;
  /**
   * The Skills this message invokes, attached in the composer with `/` or `@`.
   * Absent means none. Bounded by the kernel's `MAX_INVOKED_SKILLS_V1`; a ref names a
   * Skill, it never carries its text, so a client cannot inject instructions
   * by pretending to invoke one.
   */
  skills?: SkillRefV1[];
  /**
   * The explicit authenticated intent to replace whatever the Bot is doing
   * with this message. Without it a second command is refused exactly as it
   * always was, so a reconnecting client never interrupts a Turn by accident.
   *
   * `runId` is provenance, not the target, and it is optional. The composer
   * sends this intent on every send, because "replace what you are doing with
   * this" is what a person means by typing — and whether the client had yet
   * *observed* a run when they pressed send is a race, not a decision they
   * made. A composer that names no run still supersedes whatever is actually
   * active; one that names a run may name a stale one, and the Bot Durable
   * Object supersedes the active Turn either way.
   */
  supersedes?: { runId?: string };
}

export interface ClientNotificationAcknowledgementCommandV1 {
  schemaVersion: 1;
  action: "acknowledge";
  notificationId: string;
}

export interface ClientRunReconciliationCommandV1 {
  schemaVersion: 1;
  action: "resume";
}

/** Exact authenticated Stop command; one command targets exactly one run. */
export interface ClientRunStopCommandV1 {
  schemaVersion: 1;
  action: "stop";
  commandId: string;
  runId: string;
}

/**
 * Stop acknowledgement. `accepted` reports a durable receipt, never a claim of
 * terminal cancellation; `run` carries the authoritative projection.
 */
export interface ClientRunStopReceiptV1 {
  schemaVersion: 1;
  status: "accepted";
  commandId: string;
  runId: string;
  run: ClientRunV1;
}

export interface ClientRunLookupQueryV1 {
  schemaVersion: 1;
  runId: string;
}

export interface ClientRunAdmissionFenceCommandV1 {
  schemaVersion: 1;
  action: "fence-admission";
}

export type ClientRunLookupStateV1 =
  "not-admitted" | "running" | "reconciliation-required" | "terminal";

export type ClientRunLookupV1 =
  | { schemaVersion: 1; state: "not-admitted" }
  | {
      schemaVersion: 1;
      state: Exclude<ClientRunLookupStateV1, "not-admitted">;
      run: ClientRunV1;
    };

export type ClientRunLookup =
  | { state: "not-admitted" }
  | {
      state: Exclude<ClientRunLookupStateV1, "not-admitted">;
      run: ClientRun;
    };

export interface ClientNotificationIntentV1 {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
}

export interface ClientTurnV1 {
  schemaVersion: 1;
  runId: string;
  text: string;
  events: ClientRunEventV1[];
  notification?: ClientNotificationIntentV1;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function wireBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function truncateWireString(value: string, maximumBytes: number): string {
  if (wireBytes(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (wireBytes(value.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  const bounded = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function publicEventId(value: string, label: string): string {
  if (value.length === 0 || value.length > MAX_EVENT_ID_LENGTH) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function isTerminalRunStatus(status: ClientRunStatusV1): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "superseded"
  );
}

/** One attachment of a projected tool result. */
export interface ClientToolAttachmentV1 {
  kind: "image";
  mediaType: string;
  contentHash: string;
  bytes: number;
  /** The encoded `WorkspacePathV1` the Workspace read route takes. */
  path: string;
}

type ClientToolCallV1 = Extract<ClientRunEventV1, { type: "tool/call" }>;
type ClientToolResultV1 = Extract<ClientRunEventV1, { type: "tool/result" }>;

/**
 * One indivisible run of projected events, in the order the durable log wrote
 * them. A tool interaction is its call and its result together — truncation
 * never splits one — and a send or a hand-off is a unit of its own.
 *
 * `droppable` is false only for a tool call still waiting on its result: the
 * client draws it as running work, so dropping it would show a Turn as idle
 * while it is not.
 */
interface ProjectionUnitV1 {
  events: ClientRunEventV1[];
  droppable: boolean;
}

/**
 * What a settled Turn's tool call shows when the durable record holds no
 * result for it. Same register as the rest of the transcript copy: it tells
 * the person what is missing rather than naming an occurrence id.
 */
export const UNRECORDED_TOOL_RESULT_TEXT_V1 =
  "No result was recorded for this tool call.";

function dynamicToolCallInput(
  value: unknown,
): ClientDynamicToolCallInputV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.namespace !== "string" ||
    typeof input.toolName !== "string"
  ) {
    return undefined;
  }
  const argumentsJson = Object.hasOwn(input, "arguments")
    ? JSON.stringify(input.arguments)
    : undefined;
  return {
    namespace: truncateWireString(input.namespace, MAX_EVENT_NAME_BYTES),
    toolName: truncateWireString(input.toolName, MAX_EVENT_NAME_BYTES),
    ...(argumentsJson !== undefined &&
    wireBytes(argumentsJson) <= MAX_INPUT_BYTES
      ? { argumentsJson }
      : {}),
  };
}

function decodeDynamicToolCallInput(
  value: unknown,
): ClientDynamicToolCallInputV1 {
  const input = record(value, "run event.call.input");
  exactKeys(
    input,
    ["namespace", "toolName", "argumentsJson"],
    "run event.call.input",
  );
  return {
    namespace: wireString(
      input,
      "namespace",
      MAX_EVENT_NAME_BYTES,
      "run event.call.input",
    ),
    toolName: wireString(
      input,
      "toolName",
      MAX_EVENT_NAME_BYTES,
      "run event.call.input",
    ),
    ...(Object.hasOwn(input, "argumentsJson")
      ? {
          argumentsJson: wireString(
            input,
            "argumentsJson",
            MAX_INPUT_BYTES,
            "run event.call.input",
          ),
        }
      : {}),
  };
}

function projectionUnits(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ProjectionUnitV1[] {
  const units: ProjectionUnitV1[] = [];
  const byOccurrence = new Map<string, ProjectionUnitV1>();
  let callCount = 0;
  let projectedIncompleteSync = false;
  for (const event of events) {
    if (event.type === "tool/call") {
      if (byOccurrence.has(event.occurrenceId)) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate intent`,
        );
      }
      callCount += 1;
      const dynamicInput =
        event.name === "call_dynamic_tool"
          ? dynamicToolCallInput(event.input)
          : undefined;
      const call: ClientToolCallV1 = {
        type: "tool/call",
        call: {
          id: `tool-${callCount}`,
          name: truncateWireString(event.name, MAX_EVENT_NAME_BYTES),
          ...(dynamicInput ? { input: dynamicInput } : {}),
        },
      };
      const unit: ProjectionUnitV1 = { events: [call], droppable: false };
      units.push(unit);
      byOccurrence.set(event.occurrenceId, unit);
    } else if (event.type === "tool/result") {
      const unit = byOccurrence.get(event.occurrenceId);
      if (!unit) {
        throw new Error(
          `tool result has no matching occurrence "${event.occurrenceId}"`,
        );
      }
      if (unit.droppable) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate results`,
        );
      }
      const call = unit.events[0] as ClientToolCallV1;
      const result: ClientToolResultV1 = {
        type: "tool/result",
        callId: call.call.id,
        content: truncateWireString(event.content, MAX_EVENT_CONTENT_BYTES),
        isError: event.isError,
        ...(event.attachments && event.attachments.length > 0
          ? {
              attachments: event.attachments.map((attachment) => ({
                kind: attachment.kind,
                mediaType: attachment.mediaType,
                contentHash: attachment.contentHash,
                bytes: attachment.bytes,
                path: JSON.stringify(attachment.workspacePath),
              })),
            }
          : {}),
      };
      unit.events.push(result);
      unit.droppable = true;
    } else if (event.type === "send/to-user") {
      units.push({
        events: [{ type: "send/to-user", payload: event.payload }],
        droppable: true,
      });
    } else if (event.type === "wake/parent") {
      units.push({
        events: [
          {
            type: "wake/parent",
            message: truncateWireString(event.message, MAX_EVENT_CONTENT_BYTES),
          },
        ],
        droppable: true,
      });
    } else if (
      event.type === "computer/sync" &&
      event.status !== "ok" &&
      !projectedIncompleteSync
    ) {
      projectedIncompleteSync = true;
      units.push({
        events: [
          {
            type: "computer/sync",
            status: event.status,
            message: computerSyncCopyV1(event),
          },
        ],
        droppable: true,
      });
    } else if (event.type === "task/dispatched") {
      units.push({
        events: [
          {
            type: "task/dispatched",
            taskId: truncate(event.taskId, MAX_EVENT_ID_LENGTH),
            taskType: truncateWireString(event.taskType, MAX_EVENT_NAME_BYTES),
            description: truncateWireString(
              event.description,
              MAX_TASK_DESCRIPTION_BYTES,
            ),
            model: truncateWireString(event.model, MAX_TASK_MODEL_BYTES),
            background: event.background,
          },
        ],
        droppable: true,
      });
    }
  }
  if (isTerminalRunStatus(status)) {
    for (const unit of units) {
      if (unit.droppable) continue;
      // A settled Turn owes every tool call a result, and `Session`'s
      // interruption repairs now write one. Records already durable from
      // before that do not have it, and a READ must never throw on them: one
      // malformed row used to brick the whole transcript endpoint for ever.
      // The row degrades instead, and says exactly what is missing — not
      // through `projectClientRunOrDegradedV1`, which throws the whole Turn
      // away for an unreadable record. Everything else here is readable.
      const call = unit.events[0] as ClientToolCallV1;
      unit.events.push({
        type: "tool/result",
        callId: call.call.id,
        content: UNRECORDED_TOOL_RESULT_TEXT_V1,
        isError: true,
      });
      unit.droppable = true;
    }
  }
  return units;
}

function computerSyncCopyV1(
  event: Extract<SessionEvent, { type: "computer/sync" }>,
): string {
  if (event.status === "degraded") {
    return (
      event.detail.trim() ||
      "Some Workspace files did not sync during this turn."
    );
  }
  if (event.status === "unavailable") {
    return "Workspace files could not sync during this turn. Sync will retry the next time the Computer is used.";
  }
  if (event.status === "refused") {
    return "Workspace sync could not run for this turn.";
  }
  return "Workspace sync was skipped for this turn.";
}

function visibleEvents(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ClientRunEventV1[] {
  const units = projectionUnits(events, status);
  const complete = units.flatMap((unit) => unit.events);
  if (
    complete.length <= MAX_VISIBLE_EVENTS &&
    wireBytes(complete) <= MAX_VISIBLE_EVENT_BYTES
  ) {
    return complete;
  }
  // Oldest first: truncation drops history, never the newest thing the User is
  // waiting on. `omittedInteractions` counts dropped units, so a dropped send
  // is as visible in the marker as a dropped tool interaction.
  let retained = units;
  let omittedInteractions = 0;
  const buildProjection = (): ClientRunEventV1[] => [
    { type: "run/events-truncated", omittedInteractions },
    ...retained.flatMap((unit) => unit.events),
  ];
  let projection = buildProjection();
  while (
    projection.length > MAX_VISIBLE_EVENTS ||
    wireBytes(projection) > MAX_VISIBLE_EVENT_BYTES
  ) {
    const index = retained.findIndex((unit) => unit.droppable);
    if (index < 0) break;
    retained = [...retained.slice(0, index), ...retained.slice(index + 1)];
    omittedInteractions += 1;
    projection = buildProjection();
  }
  if (projection.length > MAX_VISIBLE_EVENTS) {
    throw new Error("run has too many pending tool interactions to project");
  }
  if (wireBytes(projection) > MAX_VISIBLE_EVENT_BYTES) {
    throw new Error("pending tool interactions exceed the wire byte limit");
  }
  return projection;
}

/**
 * What an interrupted Turn had already said, read back out of its journal.
 *
 * The kernel records a Turn's answer as it streams, so a Turn stopped or
 * superseded mid-sentence still holds every word it sent. It never reached a
 * `responseText`, because it never completed — but the partial answer is a
 * fact about what the person watched arrive, not a claim that the Turn
 * succeeded, and the thread keeps it instead of replacing it with a notice.
 */
export function assistantTextSoFarV1(
  events: readonly SessionEvent[],
  responseText = "",
): string {
  let requestId: string | undefined;
  let text = responseText;
  for (const event of events) {
    if (event.type === "assistant/chunk") {
      if (event.requestId !== requestId) {
        requestId = event.requestId;
        text = "";
      }
      text += event.text;
    } else if (event.type === "assistant/message") {
      requestId = event.requestId;
      text = event.text;
    }
  }
  return text;
}

function interruptedOutcomeTextV1(run: StoredRun): { text?: string } {
  const text = assistantTextSoFarV1(run.events, run.responseText ?? "");
  return text ? { text: truncateWireString(text, MAX_OUTCOME_BYTES) } : {};
}

/**
 * What a still-running Turn has said so far, read out of the same journal an
 * interrupted one is read from.
 *
 * The kernel appends an `assistant/chunk` per provider text delta and each
 * append lands on the run record, so the words are already durable while the
 * Turn runs; nothing here is a second copy and nothing crosses the channel.
 * Bounded exactly as an outcome is, because a long answer must not be able to
 * grow the run list past its wire budget.
 */
function partialTextV1(run: StoredRun): { partialText?: string } {
  const text = assistantTextSoFarV1(run.events);
  return text
    ? { partialText: truncateWireString(text, MAX_OUTCOME_BYTES) }
    : {};
}

function runStatus(run: StoredRun): ClientRunStatusV1 {
  return requireStoredRunV1(run).status;
}

export function projectClientRunV1(run: StoredRun): ClientRunV1 {
  const status = runStatus(run);
  const outcome =
    status === "completed"
      ? ({
          type: "completed",
          text: truncateWireString(run.responseText ?? "", MAX_OUTCOME_BYTES),
        } satisfies ClientRunOutcomeV1)
      : status === "failed"
        ? ({
            type: "failed",
            // The stored `failure` is a diagnostic and stays one: it is what
            // the debug surface reads. What crosses to a chat bubble is the
            // sentence written for the person — see `runFailureCopyV1`.
            message: truncateWireString(
              runFailureCopyV1({ failure: run.failure, events: run.events }),
              MAX_FAILURE_BYTES,
            ),
            ...interruptedOutcomeTextV1(run),
          } satisfies ClientRunOutcomeV1)
        : status === "cancelled"
          ? ({
              type: "cancelled",
              message: CANCELLED_RUN_MESSAGE,
              ...interruptedOutcomeTextV1(run),
            } satisfies ClientRunOutcomeV1)
          : status === "superseded"
            ? ({
                type: "superseded",
                message: SUPERSEDED_RUN_MESSAGE,
                ...interruptedOutcomeTextV1(run),
              } satisfies ClientRunOutcomeV1)
            : undefined;
  const recovery =
    status === "reconciliation-required"
      ? ({
          action: "resume",
          // The stored failure is the diagnostic the debug surface reads; a
          // person offered a "Try again" needs the sentence, not the reason
          // the Bot cannot answer it on its own.
          message: RESUMABLE_RUN_MESSAGE_V1,
        } satisfies ClientRunRecoveryV1)
      : undefined;
  const origin = run.admission?.origin;
  const via =
    origin?.kind === "bot"
      ? {
          kind: "bot" as const,
          name: truncateWireString(origin.fromBotName, 100),
          botId: truncate(origin.fromBotId, 128),
        }
      : origin?.kind === "voice"
        ? { kind: "voice" as const, name: "Voice" as const }
        : undefined;
  return {
    // Version 3 adds the origin marker for an agent-lane message.
    schemaVersion: 3,
    runId: truncate(run.runId, MAX_RUN_ID_LENGTH),
    admittedAt: truncate(run.acceptedAt, MAX_TIMESTAMP_LENGTH),
    input: truncateWireString(run.input, MAX_INPUT_BYTES),
    status,
    events: visibleEvents(run.events, status),
    ...(status === "running" ? partialTextV1(run) : {}),
    ...(run.stopRequestedAt
      ? {
          stopRequestedAt: truncate(run.stopRequestedAt, MAX_TIMESTAMP_LENGTH),
        }
      : {}),
    ...(status === "running" && run.phase === "queued"
      ? { queued: true as const }
      : {}),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
    ...(via ? { via } : {}),
  };
}

function lookupState(
  status: ClientRunStatusV1,
): Exclude<ClientRunLookupStateV1, "not-admitted"> {
  if (isTerminalRunStatus(status)) return "terminal";
  if (status === "reconciliation-required") {
    return "reconciliation-required";
  }
  return "running";
}

/**
 * Whether one stored run belongs to the visible conversation.
 *
 * This is the client half of the transcript seam: the Bot Durable Object keeps
 * one ordered log, and the projection — not the kernel — decides that only a
 * Turn admitted as `chat` is a Turn a person sees. A run recorded before turn
 * admission existed carries no marker and was a chat Turn, so it stays visible.
 * An automation run is reachable only through its Routine's run log.
 */
export function isVisibleRunV1(run: {
  admission?: { turnType?: string };
}): boolean {
  const type = run.admission?.turnType ?? "chat";
  return type === "chat" || type === "agent";
}

export function projectClientRunLookupV1(
  run: StoredRun | undefined,
): ClientRunLookupV1 {
  if (!run || !isVisibleRunV1(run)) {
    return { schemaVersion: 1, state: "not-admitted" };
  }
  const projected = projectClientRunV1(run);
  return {
    schemaVersion: 1,
    state: lookupState(projected.status),
    run: projected,
  };
}

function projectNotificationV1(
  notification: BotNotificationIntent,
): ClientNotificationIntentV1 {
  return {
    notificationId: truncate(notification.notificationId, MAX_EVENT_ID_LENGTH),
    runId: truncate(notification.runId, MAX_RUN_ID_LENGTH),
    createdAt: truncate(notification.createdAt, MAX_TIMESTAMP_LENGTH),
    title: truncateWireString(notification.title, MAX_NOTIFICATION_TITLE_BYTES),
    body: truncateWireString(notification.body, MAX_NOTIFICATION_BODY_BYTES),
  };
}

export function projectClientTurnV1(result: BotTurnCompletion): ClientTurnV1 {
  if (result.notification && result.notification.runId !== result.runId) {
    throw new Error("turn notification does not match its run");
  }
  return {
    schemaVersion: 1,
    runId: truncate(result.runId, MAX_RUN_ID_LENGTH),
    text: truncateWireString(result.text, MAX_OUTCOME_BYTES),
    events: visibleEvents(result.events, "completed"),
    ...(result.notification
      ? { notification: projectNotificationV1(result.notification) }
      : {}),
  };
}

/**
 * One stored run on the wire, degraded rather than thrown when the record
 * cannot be read.
 *
 * A single unreadable run — an older shape, or one a bug wrote badly — used to
 * fail the whole transcript: `GET /turns` answered 500 for every request after
 * it, and the person's entire conversation disappeared behind one bad row. The
 * transcript keeps its shape and says which Turn it could not read.
 */
export function projectClientRunOrDegradedV1(run: StoredRun): ClientRunV1 {
  try {
    return projectClientRunV1(run);
  } catch {
    const admittedAt =
      typeof run.acceptedAt === "string" &&
      Number.isFinite(Date.parse(run.acceptedAt))
        ? run.acceptedAt
        : new Date(0).toISOString();
    return {
      schemaVersion: 2,
      runId: truncate(String(run.runId ?? "unknown"), MAX_RUN_ID_LENGTH),
      admittedAt,
      input: typeof run.input === "string" ? run.input : "",
      status: "failed",
      events: [],
      outcome: {
        type: "failed",
        message: "This Turn's record could not be read.",
      },
    };
  }
}

export function projectClientRunListV1(
  runs: readonly StoredRun[],
): ClientRunListV1 {
  return createClientRunListV1(runs.map(projectClientRunV1), {
    truncated: false,
  });
}

export function createClientRunListV1(
  runs: ClientRunV1[],
  page: ClientRunPageV1,
  announcements: readonly ClientAnnouncementV1[] = [],
): ClientRunListV1 {
  return {
    schemaVersion: 1,
    runs,
    page,
    ...(announcements.length > 0 ? { announcements: [...announcements] } : {}),
  };
}

const MAX_ANNOUNCEMENTS = 64;
const MAX_ANNOUNCEMENT_NAME_BYTES = 400;

/**
 * Where each Turn ended, by Turn number.
 *
 * A compaction is written at the end of the Turn that crossed the threshold,
 * which is the *newest* Turn — so its own timestamp would place its marker at
 * the bottom of the thread, far from the range it describes. The boundary it
 * actually names is the end of `throughTurn`, and that is what the marker is
 * dated with.
 */
function turnEndTimestampsV1(
  session: readonly SessionEvent[],
): Map<number, string> {
  const ends = new Map<number, string>();
  for (const event of session) {
    if (event.type === "turn/end") ends.set(event.turn, event.timestamp);
  }
  return ends;
}

/**
 * Projects the Bot's durable announcement events onto the wire.
 *
 * `session` is the conversation's own log, used only to date a compaction
 * marker at the boundary it covers. Omitting it dates the marker by when the
 * compaction was written, which is where it used to sit.
 */
export function projectClientAnnouncementsV1(
  events: readonly SessionEvent[],
  session: readonly SessionEvent[] = events,
): ClientAnnouncementV1[] {
  const turnEnds = turnEndTimestampsV1(session);
  return events.flatMap((event): ClientAnnouncementV1[] => {
    if (event.type === "bot/renamed") {
      return [
        {
          type: "bot/renamed" as const,
          announcementId: `announcement-${event.seq}`,
          at: truncate(event.timestamp, MAX_TIMESTAMP_LENGTH),
          from: truncateWireString(event.from, MAX_ANNOUNCEMENT_NAME_BYTES),
          to: truncateWireString(event.to, MAX_ANNOUNCEMENT_NAME_BYTES),
          namedBy: event.namedBy,
        },
      ];
    }
    if (event.type === "conversation/compacted") {
      // The summary itself is deliberately not on the wire. A person can read
      // every Turn it covers, unchanged, immediately above this line; the
      // summary is what the model carries, and it belongs to the audit view.
      return [
        {
          type: "conversation/compacted" as const,
          // A distinct prefix: a compaction is numbered by the session log and
          // a rename by this Bot's announcement log, and the two counters would
          // otherwise collide on an id the client upserts by.
          announcementId: `compaction-${event.seq}`,
          // Dated where the covered range ends, not when the summariser ran,
          // so the marker sits between the last compacted Turn and the first
          // verbatim one and stays there as newer Turns arrive.
          at: truncate(
            turnEnds.get(event.throughTurn) ?? event.timestamp,
            MAX_TIMESTAMP_LENGTH,
          ),
          throughTurn: event.throughTurn,
        },
      ];
    }
    return [];
  });
}

export function clientRunListWireBytes(value: ClientRunListV1): number {
  return wireBytes(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Reflect.ownKeys(value).find(
    (key) =>
      typeof key !== "string" ||
      !allowedKeys.has(key) ||
      !Object.prototype.propertyIsEnumerable.call(value, key),
  );
  if (unexpected !== undefined) {
    const field =
      typeof unexpected === "symbol" ? unexpected.toString() : unexpected;
    throw new Error(`${label}.${field} is not allowed`);
  }
}

function string(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length > maximum) {
    throw new Error(`${label}.${key} must be a bounded string`);
  }
  return field;
}

function wireString(
  value: Record<string, unknown>,
  key: string,
  maximumBytes: number,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || wireBytes(field) > maximumBytes) {
    throw new Error(`${label}.${key} must be a wire-bounded string`);
  }
  return field;
}

function status(value: unknown): ClientRunStatusV1 {
  if (
    value !== "running" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "superseded" &&
    value !== "reconciliation-required"
  ) {
    throw new Error("run.status is invalid");
  }
  return value;
}

function decodeEvent(value: unknown): ClientRunEventV1 {
  const event = record(value, "run event");
  if (event.type === "run/events-truncated") {
    exactKeys(event, ["type", "omittedInteractions"], "run event");
    if (
      !Number.isSafeInteger(event.omittedInteractions) ||
      (event.omittedInteractions as number) <= 0
    ) {
      throw new Error(
        "run event.omittedInteractions must be a positive safe integer",
      );
    }
    return {
      type: "run/events-truncated",
      omittedInteractions: event.omittedInteractions as number,
    };
  }
  if (event.type === "tool/call") {
    exactKeys(event, ["type", "call"], "run event");
    const call = record(event.call, "run event.call");
    exactKeys(call, ["id", "name", "input"], "run event.call");
    const name = wireString(
      call,
      "name",
      MAX_EVENT_NAME_BYTES,
      "run event.call",
    );
    const input = Object.hasOwn(call, "input")
      ? decodeDynamicToolCallInput(call.input)
      : undefined;
    if (input && name !== "call_dynamic_tool") {
      throw new Error(
        "run event.call.input is valid only for a dynamic tool call",
      );
    }
    return {
      type: "tool/call",
      call: {
        id: publicEventId(
          string(call, "id", MAX_EVENT_ID_LENGTH, "run event.call"),
          "run event.call.id",
        ),
        name,
        ...(input ? { input } : {}),
      },
    };
  }
  if (event.type === "tool/result") {
    exactKeys(event, ["type", "callId", "content", "isError"], "run event");
    if (typeof event.isError !== "boolean") {
      throw new Error("run event.isError must be a boolean");
    }
    return {
      type: "tool/result",
      callId: publicEventId(
        string(event, "callId", MAX_EVENT_ID_LENGTH, "run event"),
        "run event.callId",
      ),
      content: wireString(
        event,
        "content",
        MAX_EVENT_CONTENT_BYTES,
        "run event",
      ),
      isError: event.isError,
    };
  }
  if (event.type === "send/to-user") {
    exactKeys(event, ["type", "payload"], "run event");
    return {
      type: "send/to-user",
      payload: decodeSendToUserPayloadV1(event.payload, "run event.payload"),
    };
  }
  if (event.type === "wake/parent") {
    exactKeys(event, ["type", "message"], "run event");
    return {
      type: "wake/parent",
      message: wireString(
        event,
        "message",
        MAX_EVENT_CONTENT_BYTES,
        "run event",
      ),
    };
  }
  if (event.type === "computer/sync") {
    exactKeys(event, ["type", "status", "message"], "run event");
    if (
      event.status !== "degraded" &&
      event.status !== "unavailable" &&
      event.status !== "refused" &&
      event.status !== "skipped"
    ) {
      throw new Error("run event.status is invalid");
    }
    return {
      type: "computer/sync",
      status: event.status,
      message: wireString(
        event,
        "message",
        MAX_EVENT_CONTENT_BYTES,
        "run event",
      ),
    };
  }
  if (event.type === "task/dispatched") {
    exactKeys(
      event,
      ["type", "taskId", "taskType", "description", "model", "background"],
      "run event",
    );
    if (typeof event.background !== "boolean") {
      throw new Error("run event.background must be a boolean");
    }
    return {
      type: "task/dispatched",
      taskId: publicEventId(
        string(event, "taskId", MAX_EVENT_ID_LENGTH, "run event"),
        "run event.taskId",
      ),
      taskType: wireString(
        event,
        "taskType",
        MAX_EVENT_NAME_BYTES,
        "run event",
      ),
      description: wireString(
        event,
        "description",
        MAX_TASK_DESCRIPTION_BYTES,
        "run event",
      ),
      model: wireString(event, "model", MAX_TASK_MODEL_BYTES, "run event"),
      background: event.background,
    };
  }
  throw new Error("run event.type is invalid");
}

/**
 * The event walk a wire run is decoded through. It no longer takes the run's
 * status: a settled Turn's tool call with no result is a row the projection
 * has already degraded, not a message to refuse.
 */
function decodeEvents(values: unknown[]): ClientTurnEvent[] {
  const events = values.map(decodeEvent);
  let index = 0;
  if (events[0]?.type === "run/events-truncated") index = 1;
  if (
    events.slice(index).some((event) => event.type === "run/events-truncated")
  ) {
    throw new Error("run truncation marker must be the first event");
  }
  const callIds = new Set<string>();
  while (index < events.length) {
    const call = events[index];
    // Sends, hand-offs, task chips, and sync notices stand alone: they pair
    // with nothing, so the call/result walk steps straight over them.
    if (
      call?.type === "send/to-user" ||
      call?.type === "wake/parent" ||
      call?.type === "task/dispatched" ||
      call?.type === "computer/sync"
    ) {
      index += 1;
      continue;
    }
    if (call?.type !== "tool/call") {
      throw new Error("run tool result has no matching call");
    }
    const id = call.call.id;
    if (callIds.has(id)) {
      throw new Error(`run tool call "${id}" is duplicated`);
    }
    callIds.add(id);
    const result = events[index + 1];
    if (result?.type === "tool/result") {
      if (result.callId !== id) {
        throw new Error(`run tool result does not match call "${id}"`);
      }
      index += 2;
      continue;
    }
    // A settled Turn whose call has no result is a degraded row, not a bad
    // wire message: the projection above already renders it as "no result
    // recorded", and refusing it here would put the whole transcript behind
    // one durable record nobody can now repair.
    index += 1;
  }
  return events;
}

function decodeOutcome(
  value: unknown,
  runStatus: ClientRunStatusV1,
): ClientRunOutcomeV1 | undefined {
  if (value === undefined) {
    if (isTerminalRunStatus(runStatus)) {
      throw new Error("terminal run.outcome is required");
    }
    return undefined;
  }
  const outcome = record(value, "run.outcome");
  if (outcome.type === "completed" && runStatus === "completed") {
    exactKeys(outcome, ["type", "text"], "run.outcome");
    return {
      type: "completed",
      text: wireString(outcome, "text", MAX_OUTCOME_BYTES, "run.outcome"),
    };
  }
  if (outcome.type === "failed" && runStatus === "failed") {
    exactKeys(outcome, ["type", "message", "text"], "run.outcome");
    return {
      type: "failed",
      message: wireString(outcome, "message", MAX_FAILURE_BYTES, "run.outcome"),
      ...decodeInterruptedTextV1(outcome),
    };
  }
  if (outcome.type === "cancelled" && runStatus === "cancelled") {
    exactKeys(outcome, ["type", "message", "text"], "run.outcome");
    return {
      type: "cancelled",
      message: wireString(outcome, "message", MAX_FAILURE_BYTES, "run.outcome"),
      ...decodeInterruptedTextV1(outcome),
    };
  }
  if (outcome.type === "superseded" && runStatus === "superseded") {
    exactKeys(outcome, ["type", "message", "text"], "run.outcome");
    return {
      type: "superseded",
      message: wireString(outcome, "message", MAX_FAILURE_BYTES, "run.outcome"),
      ...decodeInterruptedTextV1(outcome),
    };
  }
  throw new Error("run.outcome does not match run.status");
}

/** The partial answer an interrupted Turn kept, when it said anything. */
function decodeInterruptedTextV1(outcome: Record<string, unknown>): {
  text?: string;
} {
  if (outcome.text === undefined) return {};
  return {
    text: wireString(outcome, "text", MAX_OUTCOME_BYTES, "run.outcome"),
  };
}

function decodeRecovery(
  value: unknown,
  runStatus: ClientRunStatusV1,
): ClientRunRecoveryV1 | undefined {
  if (value === undefined) {
    if (runStatus === "reconciliation-required") {
      throw new Error("reconciliation-required run.recovery is required");
    }
    return undefined;
  }
  if (runStatus !== "reconciliation-required") {
    throw new Error("run.recovery does not match run.status");
  }
  const recovery = record(value, "run.recovery");
  exactKeys(recovery, ["action", "message"], "run.recovery");
  if (recovery.action !== "resume") {
    throw new Error("run.recovery.action is invalid");
  }
  return {
    action: "resume",
    message: wireString(recovery, "message", MAX_FAILURE_BYTES, "run.recovery"),
  };
}

function decodeRun(value: unknown): ClientRun {
  const run = record(value, "run");
  exactKeys(
    run,
    [
      "schemaVersion",
      "runId",
      "admittedAt",
      "input",
      "status",
      "events",
      "stopRequestedAt",
      "queued",
      "partialText",
      "outcome",
      "recovery",
      "via",
    ],
    "run",
  );
  // 1 and 2 differ only by the event types a version 2 body may carry, and a
  // version 1 body carries a subset of them, so one walk decodes both.
  if (
    run.schemaVersion !== 1 &&
    run.schemaVersion !== 2 &&
    run.schemaVersion !== 3
  ) {
    throw new Error("run.schemaVersion is invalid");
  }
  let via: ClientRunV1["via"];
  if (run.via !== undefined) {
    if (run.schemaVersion !== 3) {
      throw new Error("run.via requires schemaVersion 3");
    }
    const candidate = record(run.via, "run.via");
    if (candidate.kind === "bot") {
      exactKeys(candidate, ["kind", "name", "botId"], "run.via");
      via = {
        kind: "bot",
        name: wireString(candidate, "name", 100, "run.via"),
        botId: string(candidate, "botId", 128, "run.via"),
      };
    } else if (candidate.kind === "voice") {
      exactKeys(candidate, ["kind", "name"], "run.via");
      if (candidate.name !== "Voice")
        throw new Error("run.via.name is invalid");
      via = { kind: "voice", name: "Voice" };
    } else {
      throw new Error("run.via.kind is invalid");
    }
  }
  let runId: string;
  try {
    runId = decodeRunIdV1(string(run, "runId", MAX_RUN_ID_LENGTH, "run"));
  } catch {
    throw new Error("run.runId is invalid");
  }
  const admittedAt = string(run, "admittedAt", MAX_TIMESTAMP_LENGTH, "run");
  if (!Number.isFinite(Date.parse(admittedAt))) {
    throw new Error("run.admittedAt is invalid");
  }
  if (!Array.isArray(run.events) || run.events.length > MAX_VISIBLE_EVENTS) {
    throw new Error("run.events must be a bounded array");
  }
  const runStatus = status(run.status);
  const outcome = decodeOutcome(run.outcome, runStatus);
  const recovery = decodeRecovery(run.recovery, runStatus);
  let stopRequestedAt: string | undefined;
  if (run.stopRequestedAt !== undefined) {
    stopRequestedAt = string(
      run,
      "stopRequestedAt",
      MAX_TIMESTAMP_LENGTH,
      "run",
    );
    if (!Number.isFinite(Date.parse(stopRequestedAt))) {
      throw new Error("run.stopRequestedAt is invalid");
    }
  }
  if (runStatus === "cancelled" && stopRequestedAt === undefined) {
    throw new Error("cancelled run.stopRequestedAt is required");
  }
  if (run.queued !== undefined && run.queued !== true) {
    throw new Error("run.queued is invalid");
  }
  if (run.queued === true && runStatus !== "running") {
    throw new Error("only a running run may be queued");
  }
  let partialText: string | undefined;
  if (run.partialText !== undefined) {
    // A settled run's answer is its outcome. Carrying both would give the
    // thread two sources for one bubble, which is the duplication the
    // one-bubble contract exists to prevent.
    if (runStatus !== "running") {
      throw new Error("only a running run may carry partial text");
    }
    partialText = wireString(run, "partialText", MAX_OUTCOME_BYTES, "run");
  }
  return {
    runId,
    admittedAt,
    input: wireString(run, "input", MAX_INPUT_BYTES, "run"),
    status: runStatus,
    events: decodeEvents(run.events),
    ...(stopRequestedAt ? { stopRequestedAt } : {}),
    ...(run.queued === true ? { queued: true as const } : {}),
    ...(partialText ? { partialText } : {}),
    ...(outcome?.type === "completed" ? { responseText: outcome.text } : {}),
    ...(outcome?.type === "failed"
      ? {
          failure: outcome.message,
          ...(outcome.text ? { responseText: outcome.text } : {}),
        }
      : {}),
    ...(outcome?.type === "cancelled" || outcome?.type === "superseded"
      ? {
          failure: outcome.message,
          ...(outcome.text ? { responseText: outcome.text } : {}),
        }
      : {}),
    ...(recovery ? { failure: recovery.message, recovery } : {}),
    ...(via ? { via } : {}),
  };
}

function decodePage(value: unknown): ClientRunPageV1 {
  const page = record(value, "run list.page");
  exactKeys(page, ["truncated", "nextCursor"], "run list.page");
  if (typeof page.truncated !== "boolean") {
    throw new Error("run list.page.truncated must be a boolean");
  }
  const nextCursor =
    page.nextCursor === undefined
      ? undefined
      : decodeRunCursorV1(
          string(page, "nextCursor", MAX_CURSOR_LENGTH, "run list.page"),
        );
  if (page.truncated && !nextCursor) {
    throw new Error("truncated run list requires a next cursor");
  }
  if (!page.truncated && nextCursor !== undefined) {
    throw new Error("complete run list must not include a next cursor");
  }
  return {
    truncated: page.truncated,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function decodeNotificationV1(value: unknown): ClientNotificationIntent {
  const notification = record(value, "turn.notification");
  exactKeys(
    notification,
    ["notificationId", "runId", "createdAt", "title", "body"],
    "turn.notification",
  );
  const createdAt = string(
    notification,
    "createdAt",
    MAX_TIMESTAMP_LENGTH,
    "turn.notification",
  );
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("turn.notification.createdAt is invalid");
  }
  return {
    notificationId: publicEventId(
      string(
        notification,
        "notificationId",
        MAX_EVENT_ID_LENGTH,
        "turn.notification",
      ),
      "turn.notification.notificationId",
    ),
    runId: string(
      notification,
      "runId",
      MAX_RUN_ID_LENGTH,
      "turn.notification",
    ),
    createdAt,
    title: wireString(
      notification,
      "title",
      MAX_NOTIFICATION_TITLE_BYTES,
      "turn.notification",
    ),
    body: wireString(
      notification,
      "body",
      MAX_NOTIFICATION_BODY_BYTES,
      "turn.notification",
    ),
  };
}

export function decodeClientTurnV1(input: unknown): ClientTurnResponse {
  const turn = record(input, "turn");
  exactKeys(
    turn,
    ["schemaVersion", "runId", "text", "events", "notification"],
    "turn",
  );
  if (turn.schemaVersion !== 1) {
    throw new Error("turn.schemaVersion is invalid");
  }
  if (!Array.isArray(turn.events) || turn.events.length > MAX_VISIBLE_EVENTS) {
    throw new Error("turn.events must be a bounded array");
  }
  if (wireBytes(input) > MAX_CLIENT_TURN_BYTES) {
    throw new Error("turn exceeds the wire byte limit");
  }
  let runId: string;
  try {
    runId = decodeRunIdV1(string(turn, "runId", MAX_RUN_ID_LENGTH, "turn"));
  } catch {
    throw new Error("turn.runId is invalid");
  }
  const notification =
    turn.notification === undefined
      ? undefined
      : decodeNotificationV1(turn.notification);
  if (notification && notification.runId !== runId) {
    throw new Error("turn.notification.runId does not match turn.runId");
  }
  return {
    runId,
    text: wireString(turn, "text", MAX_OUTCOME_BYTES, "turn"),
    events: decodeEvents(turn.events),
    ...(notification ? { notification } : {}),
  };
}

export function decodeClientRunListQueryV1(
  input: unknown,
): ClientRunListQueryV1 {
  const query = record(input, "run list query");
  exactKeys(
    query,
    ["schemaVersion", "before", "conversationId"],
    "run list query",
  );
  if (query.schemaVersion !== 1) {
    throw new Error("run list query.schemaVersion is invalid");
  }
  const before =
    query.before === undefined
      ? undefined
      : string(query, "before", MAX_CURSOR_LENGTH, "run list query");
  if (before !== undefined) {
    try {
      decodeRunCursorV1(before);
    } catch {
      throw new Error("run list query.before is invalid");
    }
  }
  const conversationId =
    query.conversationId === undefined
      ? undefined
      : string(
          query,
          "conversationId",
          MAX_SESSION_ID_LENGTH,
          "run list query",
        );
  return {
    schemaVersion: 1,
    ...(before ? { before } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function decodeClientTurnCommandV1(input: unknown): ClientTurnCommandV1 {
  const command = record(input, "turn command");
  exactKeys(
    command,
    ["schemaVersion", "commandId", "text", "skills", "supersedes"],
    "turn command",
  );
  if (command.schemaVersion !== 1) {
    throw new Error("turn command.schemaVersion is invalid");
  }
  const commandId = string(
    command,
    "commandId",
    MAX_RUN_ID_LENGTH,
    "turn command",
  );
  if (!isPublicIdentifier(commandId)) {
    throw new Error("turn command.commandId is invalid");
  }
  const text = wireString(
    command,
    "text",
    MAX_INPUT_BYTES,
    "turn command",
  ).trim();
  if (!text) throw new Error("turn command.text is required");
  let supersedes: { runId?: string } | undefined;
  if (command.supersedes !== undefined) {
    const named = record(command.supersedes, "turn command.supersedes");
    exactKeys(named, ["runId"], "turn command.supersedes");
    if (named.runId === undefined) {
      // Intent with no provenance: the composer sent while it had observed no
      // running Turn. It still means "replace whatever you are doing".
      supersedes = {};
    } else {
      try {
        supersedes = {
          runId: decodeRunIdV1(
            string(
              named,
              "runId",
              MAX_RUN_ID_LENGTH,
              "turn command.supersedes",
            ),
          ),
        };
      } catch {
        throw new Error("turn command.supersedes.runId is invalid");
      }
    }
  }
  const skills =
    command.skills === undefined
      ? []
      : decodeSkillRefsV1(command.skills, "turn command.skills");
  return {
    schemaVersion: 1,
    commandId,
    text,
    ...(skills.length > 0 ? { skills } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}

export function decodeClientNotificationAcknowledgementCommandV1(
  input: unknown,
): ClientNotificationAcknowledgementCommandV1 {
  const command = record(input, "notification acknowledgement command");
  exactKeys(
    command,
    ["schemaVersion", "action", "notificationId"],
    "notification acknowledgement command",
  );
  if (command.schemaVersion !== 1 || command.action !== "acknowledge") {
    throw new Error("notification acknowledgement command is invalid");
  }
  const notificationId = string(
    command,
    "notificationId",
    MAX_RUN_ID_LENGTH,
    "notification acknowledgement command",
  );
  // `isRpcIdentifier`, not `isPublicIdentifier`: the same bounded alphabet
  // plus `:` and `@`. New ids are minted through `notificationIdV1` and carry
  // neither, but Bots in the field are already holding notifications whose ids
  // were interpolated by hand — `composition-failure:<generationId>:<attempt>`
  // and three more like it. Under the stricter pattern those could never be
  // acknowledged, so the client retried them forever and the Bot answered 400
  // on every poll for the rest of its life. Accepting them here is what lets
  // an already-wedged Bot recover without a storage sweep.
  if (!isRpcIdentifier(notificationId)) {
    throw new Error(
      "notification acknowledgement command.notificationId is invalid",
    );
  }
  return { schemaVersion: 1, action: "acknowledge", notificationId };
}

export function decodeClientRunReconciliationCommandV1(
  input: unknown,
): ClientRunReconciliationCommandV1 {
  const command = record(input, "run reconciliation command");
  exactKeys(command, ["schemaVersion", "action"], "run reconciliation command");
  if (command.schemaVersion !== 1 || command.action !== "resume") {
    throw new Error("run reconciliation command is invalid");
  }
  return { schemaVersion: 1, action: "resume" };
}

export function decodeClientRunStopCommandV1(
  input: unknown,
): ClientRunStopCommandV1 {
  const command = record(input, "run stop command");
  exactKeys(
    command,
    ["schemaVersion", "action", "commandId", "runId"],
    "run stop command",
  );
  if (command.schemaVersion !== 1 || command.action !== "stop") {
    throw new Error("run stop command is invalid");
  }
  const commandId = string(
    command,
    "commandId",
    MAX_RUN_ID_LENGTH,
    "run stop command",
  );
  if (!isPublicIdentifier(commandId)) {
    throw new Error("run stop command.commandId is invalid");
  }
  let runId: string;
  try {
    runId = decodeRunIdV1(
      string(command, "runId", MAX_RUN_ID_LENGTH, "run stop command"),
    );
  } catch {
    throw new Error("run stop command.runId is invalid");
  }
  return { schemaVersion: 1, action: "stop", commandId, runId };
}

export function createClientRunStopReceiptV1(
  command: ClientRunStopCommandV1,
  run: ClientRunV1,
): ClientRunStopReceiptV1 {
  if (run.runId !== command.runId) {
    throw new Error("run stop receipt does not match its command");
  }
  return {
    schemaVersion: 1,
    status: "accepted",
    commandId: command.commandId,
    runId: command.runId,
    run,
  };
}

export function decodeClientRunStopReceiptV1(input: unknown): {
  commandId: string;
  runId: string;
  run: ClientRun;
} {
  const receipt = record(input, "run stop receipt");
  exactKeys(
    receipt,
    ["schemaVersion", "status", "commandId", "runId", "run"],
    "run stop receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.status !== "accepted") {
    throw new Error("run stop receipt is invalid");
  }
  if (wireBytes(input) > CLIENT_RUN_LIST_MAX_BYTES) {
    throw new Error("run stop receipt exceeds the wire byte limit");
  }
  const commandId = string(
    receipt,
    "commandId",
    MAX_RUN_ID_LENGTH,
    "run stop receipt",
  );
  if (!isPublicIdentifier(commandId)) {
    throw new Error("run stop receipt.commandId is invalid");
  }
  const runId = string(receipt, "runId", MAX_RUN_ID_LENGTH, "run stop receipt");
  const run = decodeRun(receipt.run);
  if (run.runId !== runId) {
    throw new Error("run stop receipt.run does not match run stop receipt");
  }
  return { commandId, runId, run };
}

export function decodeClientRunLookupQueryV1(
  input: unknown,
): ClientRunLookupQueryV1 {
  const query = record(input, "run lookup query");
  exactKeys(query, ["schemaVersion", "runId"], "run lookup query");
  if (query.schemaVersion !== 1) {
    throw new Error("run lookup query.schemaVersion is invalid");
  }
  let runId: string;
  try {
    runId = decodeRunIdV1(
      string(query, "runId", MAX_RUN_ID_LENGTH, "run lookup query"),
    );
  } catch {
    throw new Error("run lookup query.runId is invalid");
  }
  return { schemaVersion: 1, runId };
}

export function decodeClientRunAdmissionFenceCommandV1(
  input: unknown,
): ClientRunAdmissionFenceCommandV1 {
  const command = record(input, "run admission fence command");
  exactKeys(
    command,
    ["schemaVersion", "action"],
    "run admission fence command",
  );
  if (command.schemaVersion !== 1 || command.action !== "fence-admission") {
    throw new Error("run admission fence command is invalid");
  }
  return { schemaVersion: 1, action: "fence-admission" };
}

export function decodeClientRunLookupV1(input: unknown): ClientRunLookup {
  const lookup = record(input, "run lookup");
  exactKeys(lookup, ["schemaVersion", "state", "run"], "run lookup");
  if (lookup.schemaVersion !== 1) {
    throw new Error("run lookup.schemaVersion is invalid");
  }
  if (wireBytes(input) > CLIENT_RUN_LIST_MAX_BYTES) {
    throw new Error("run lookup exceeds the wire byte limit");
  }
  if (lookup.state === "not-admitted") {
    if (lookup.run !== undefined) {
      throw new Error("not-admitted run lookup must not include a run");
    }
    return { state: "not-admitted" };
  }
  if (
    lookup.state !== "running" &&
    lookup.state !== "reconciliation-required" &&
    lookup.state !== "terminal"
  ) {
    throw new Error("run lookup.state is invalid");
  }
  if (lookup.run === undefined) {
    throw new Error("admitted run lookup requires a run");
  }
  const run = decodeRun(lookup.run);
  if (lookupState(run.status) !== lookup.state) {
    throw new Error("run lookup.state does not match run.status");
  }
  return { state: lookup.state, run };
}

function decodeAnnouncement(value: unknown): ClientAnnouncementV1 {
  const announcement = record(value, "run list.announcement");
  if (
    announcement.type !== "bot/renamed" &&
    announcement.type !== "conversation/compacted"
  ) {
    throw new Error("run list.announcement.type is invalid");
  }
  exactKeys(
    announcement,
    announcement.type === "conversation/compacted"
      ? ["type", "announcementId", "at", "throughTurn"]
      : ["type", "announcementId", "at", "from", "to", "namedBy"],
    "run list.announcement",
  );
  const at = string(
    announcement,
    "at",
    MAX_TIMESTAMP_LENGTH,
    "run list.announcement",
  );
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error("run list.announcement.at is invalid");
  }
  const announcementId = publicEventId(
    string(
      announcement,
      "announcementId",
      MAX_EVENT_ID_LENGTH,
      "run list.announcement",
    ),
    "run list.announcement.announcementId",
  );
  if (announcement.type === "conversation/compacted") {
    if (
      !Number.isSafeInteger(announcement.throughTurn) ||
      (announcement.throughTurn as number) < 1
    ) {
      throw new Error("run list.announcement.throughTurn is invalid");
    }
    return {
      type: "conversation/compacted",
      announcementId,
      at,
      throughTurn: announcement.throughTurn as number,
    };
  }
  if (announcement.namedBy !== "user" && announcement.namedBy !== "bot") {
    throw new Error("run list.announcement.namedBy is invalid");
  }
  return {
    type: "bot/renamed",
    announcementId,
    at,
    from: wireString(
      announcement,
      "from",
      MAX_ANNOUNCEMENT_NAME_BYTES,
      "run list.announcement",
    ),
    to: wireString(
      announcement,
      "to",
      MAX_ANNOUNCEMENT_NAME_BYTES,
      "run list.announcement",
    ),
    namedBy: announcement.namedBy,
  };
}

export function decodeClientRunPageV1(input: unknown): {
  runs: ClientRun[];
  page: ClientRunPageV1;
  announcements: ClientAnnouncementV1[];
} {
  const list = record(input, "run list");
  exactKeys(
    list,
    ["schemaVersion", "runs", "page", "announcements"],
    "run list",
  );
  if (list.schemaVersion !== 1) {
    throw new Error("run list.schemaVersion is invalid");
  }
  if (!Array.isArray(list.runs)) {
    throw new Error("run list.runs must be an array");
  }
  if (list.runs.length > CLIENT_RUN_PAGE_LIMIT) {
    throw new Error("run list.runs exceeds the page limit");
  }
  if (wireBytes(input) > CLIENT_RUN_LIST_MAX_BYTES) {
    throw new Error("run list exceeds the wire byte limit");
  }
  if (
    list.announcements !== undefined &&
    (!Array.isArray(list.announcements) ||
      list.announcements.length > MAX_ANNOUNCEMENTS)
  ) {
    throw new Error("run list.announcements must be a bounded array");
  }
  const decoded = {
    runs: list.runs.map(decodeRun),
    page: decodePage(list.page),
    announcements: (list.announcements ?? []).map(decodeAnnouncement),
  };
  return decoded;
}

export function decodeClientRunListV1(input: unknown): ClientRun[] {
  return decodeClientRunPageV1(input).runs;
}
