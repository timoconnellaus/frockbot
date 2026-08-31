import {
  decodeSendToUserPayloadV1,
  type SendToUserPayloadV1,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import { isPublicIdentifier } from "@frockbot/configuration-core";
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
const RUN_CURSOR_PATTERN = /^run-index:(.{24}):(.+)$/;
export const CLIENT_RUN_PAGE_LIMIT = 32;

function decodeRunCursor(value: string): string {
  const match = RUN_CURSOR_PATTERN.exec(value);
  const acceptedAt = match?.[1];
  const runId = match?.[2];
  if (
    !acceptedAt ||
    !runId ||
    !Number.isFinite(Date.parse(acceptedAt)) ||
    new Date(acceptedAt).toISOString() !== acceptedAt
  ) {
    throw new Error("run cursor is invalid");
  }
  try {
    decodeRunIdV1(runId);
  } catch {
    throw new Error("run cursor is invalid");
  }
  return value;
}
export const CLIENT_RUN_LIST_MAX_BYTES = 512_000;

export type ClientRunStatusV1 =
  "running" | "completed" | "failed" | "cancelled" | "reconciliation-required";

const CANCELLED_RUN_MESSAGE = "Stopped by an authenticated Stop command.";

export type ClientRunEventV1 =
  | {
      type: "run/events-truncated";
      omittedInteractions: number;
    }
  | {
      type: "tool/call";
      call: { id: string; name: string };
    }
  | {
      type: "tool/result";
      callId: string;
      content: string;
      isError: boolean;
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
    };

export type ClientRunOutcomeV1 =
  | { type: "completed"; text: string }
  | { type: "failed"; message: string }
  | { type: "cancelled"; message: string };

export interface ClientRunRecoveryV1 {
  action: "resume";
  message: string;
}

/**
 * The run projection. Version 2 adds `send/to-user` and `wake/parent` to
 * `events`; a version 1 body is a version 2 body that carries neither, so the
 * decoder accepts both and the projection emits 2.
 */
export interface ClientRunV1 {
  schemaVersion: 1 | 2;
  runId: string;
  admittedAt: string;
  input: string;
  status: ClientRunStatusV1;
  events: ClientRunEventV1[];
  /** Durable Stop intent, projected independently of the run status. */
  stopRequestedAt?: string;
  outcome?: ClientRunOutcomeV1;
  recovery?: ClientRunRecoveryV1;
}

export interface ClientRunPageV1 {
  truncated: boolean;
  nextCursor?: string;
}

/**
 * A durable Session event that belongs to no Turn. The WebUI renders it as a
 * system line in the conversation.
 */
export interface ClientAnnouncementV1 {
  type: "bot/renamed";
  announcementId: string;
  at: string;
  from: string;
  to: string;
  namedBy: "user" | "bot";
}

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

export interface ClientRunListQueryV1 {
  schemaVersion: 1;
  before?: string;
}

export interface ClientTurnCommandV1 {
  schemaVersion: 1;
  commandId: string;
  text: string;
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
    status === "completed" || status === "failed" || status === "cancelled"
  );
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

function projectionUnits(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ProjectionUnitV1[] {
  const units: ProjectionUnitV1[] = [];
  const byOccurrence = new Map<string, ProjectionUnitV1>();
  let callCount = 0;
  for (const event of events) {
    if (event.type === "tool/call") {
      if (byOccurrence.has(event.occurrenceId)) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate intent`,
        );
      }
      callCount += 1;
      const call: ClientToolCallV1 = {
        type: "tool/call",
        call: {
          id: `tool-${callCount}`,
          name: truncateWireString(event.name, MAX_EVENT_NAME_BYTES),
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
    }
  }
  if (isTerminalRunStatus(status)) {
    const orphaned = units.find((unit) => !unit.droppable);
    if (orphaned) {
      const call = orphaned.events[0] as ClientToolCallV1;
      throw new Error(
        `terminal run has no result for tool call "${call.call.id}"`,
      );
    }
  }
  return units;
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
            message: truncateWireString(
              run.failure ?? "Agent request failed.",
              MAX_FAILURE_BYTES,
            ),
          } satisfies ClientRunOutcomeV1)
        : status === "cancelled"
          ? ({
              type: "cancelled",
              message: CANCELLED_RUN_MESSAGE,
            } satisfies ClientRunOutcomeV1)
          : undefined;
  const recovery =
    status === "reconciliation-required"
      ? ({
          action: "resume",
          message: truncateWireString(
            run.failure ??
              "Provider reconciliation is required before this Turn can continue.",
            MAX_FAILURE_BYTES,
          ),
        } satisfies ClientRunRecoveryV1)
      : undefined;
  return {
    // Version 2: the projection may now carry `send/to-user` and
    // `wake/parent`. A client pinned to 1 keeps decoding a stored list.
    schemaVersion: 2,
    runId: truncate(run.runId, MAX_RUN_ID_LENGTH),
    admittedAt: truncate(run.acceptedAt, MAX_TIMESTAMP_LENGTH),
    input: truncateWireString(run.input, MAX_INPUT_BYTES),
    status,
    events: visibleEvents(run.events, status),
    ...(run.stopRequestedAt
      ? {
          stopRequestedAt: truncate(run.stopRequestedAt, MAX_TIMESTAMP_LENGTH),
        }
      : {}),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function lookupState(
  status: ClientRunStatusV1,
): Exclude<ClientRunLookupStateV1, "not-admitted"> {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return "terminal";
  }
  if (status === "reconciliation-required") {
    return "reconciliation-required";
  }
  return "running";
}

export function projectClientRunLookupV1(
  run: StoredRun | undefined,
): ClientRunLookupV1 {
  if (!run) return { schemaVersion: 1, state: "not-admitted" };
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

/** Projects the Bot's durable announcement events onto the wire. */
export function projectClientAnnouncementsV1(
  events: readonly SessionEvent[],
): ClientAnnouncementV1[] {
  return events.flatMap((event) =>
    event.type === "bot/renamed"
      ? [
          {
            type: "bot/renamed" as const,
            announcementId: `announcement-${event.seq}`,
            at: truncate(event.timestamp, MAX_TIMESTAMP_LENGTH),
            from: truncateWireString(event.from, MAX_ANNOUNCEMENT_NAME_BYTES),
            to: truncateWireString(event.to, MAX_ANNOUNCEMENT_NAME_BYTES),
            namedBy: event.namedBy,
          },
        ]
      : [],
  );
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
    exactKeys(call, ["id", "name"], "run event.call");
    return {
      type: "tool/call",
      call: {
        id: publicEventId(
          string(call, "id", MAX_EVENT_ID_LENGTH, "run event.call"),
          "run event.call.id",
        ),
        name: wireString(call, "name", MAX_EVENT_NAME_BYTES, "run event.call"),
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
  throw new Error("run event.type is invalid");
}

function decodeEvents(
  values: unknown[],
  runStatus: ClientRunStatusV1,
): ClientTurnEvent[] {
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
    // A send and a hand-off stand alone: they pair with nothing, so the
    // call/result walk steps straight over them.
    if (call?.type === "send/to-user" || call?.type === "wake/parent") {
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
    if (isTerminalRunStatus(runStatus)) {
      throw new Error(`terminal run has no result for tool call "${id}"`);
    }
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
    exactKeys(outcome, ["type", "message"], "run.outcome");
    return {
      type: "failed",
      message: wireString(outcome, "message", MAX_FAILURE_BYTES, "run.outcome"),
    };
  }
  if (outcome.type === "cancelled" && runStatus === "cancelled") {
    exactKeys(outcome, ["type", "message"], "run.outcome");
    return {
      type: "cancelled",
      message: wireString(outcome, "message", MAX_FAILURE_BYTES, "run.outcome"),
    };
  }
  throw new Error("run.outcome does not match run.status");
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
      "outcome",
      "recovery",
    ],
    "run",
  );
  // 1 and 2 differ only by the event types a version 2 body may carry, and a
  // version 1 body carries a subset of them, so one walk decodes both.
  if (run.schemaVersion !== 1 && run.schemaVersion !== 2) {
    throw new Error("run.schemaVersion is invalid");
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
  return {
    runId,
    admittedAt,
    input: wireString(run, "input", MAX_INPUT_BYTES, "run"),
    status: runStatus,
    events: decodeEvents(run.events, runStatus),
    ...(stopRequestedAt ? { stopRequestedAt } : {}),
    ...(outcome?.type === "completed" ? { responseText: outcome.text } : {}),
    ...(outcome?.type === "failed" ? { failure: outcome.message } : {}),
    ...(outcome?.type === "cancelled" ? { failure: outcome.message } : {}),
    ...(recovery ? { failure: recovery.message, recovery } : {}),
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
      : decodeRunCursor(
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
    events: decodeEvents(turn.events, "completed"),
    ...(notification ? { notification } : {}),
  };
}

export function decodeClientRunListQueryV1(
  input: unknown,
): ClientRunListQueryV1 {
  const query = record(input, "run list query");
  exactKeys(query, ["schemaVersion", "before"], "run list query");
  if (query.schemaVersion !== 1) {
    throw new Error("run list query.schemaVersion is invalid");
  }
  const before =
    query.before === undefined
      ? undefined
      : string(query, "before", MAX_CURSOR_LENGTH, "run list query");
  if (before !== undefined) {
    try {
      decodeRunCursor(before);
    } catch {
      throw new Error("run list query.before is invalid");
    }
  }
  return { schemaVersion: 1, ...(before ? { before } : {}) };
}

export function decodeClientTurnCommandV1(input: unknown): ClientTurnCommandV1 {
  const command = record(input, "turn command");
  exactKeys(command, ["schemaVersion", "commandId", "text"], "turn command");
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
  return { schemaVersion: 1, commandId, text };
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
  if (!isPublicIdentifier(notificationId)) {
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
  exactKeys(
    announcement,
    ["type", "announcementId", "at", "from", "to", "namedBy"],
    "run list.announcement",
  );
  if (announcement.type !== "bot/renamed") {
    throw new Error("run list.announcement.type is invalid");
  }
  const at = string(
    announcement,
    "at",
    MAX_TIMESTAMP_LENGTH,
    "run list.announcement",
  );
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error("run list.announcement.at is invalid");
  }
  if (announcement.namedBy !== "user" && announcement.namedBy !== "bot") {
    throw new Error("run list.announcement.namedBy is invalid");
  }
  return {
    type: "bot/renamed",
    announcementId: publicEventId(
      string(
        announcement,
        "announcementId",
        MAX_EVENT_ID_LENGTH,
        "run list.announcement",
      ),
      "run list.announcement.announcementId",
    ),
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
