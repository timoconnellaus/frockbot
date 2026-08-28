import type { SessionEvent } from "@frockbot/agent-core";
import type {
  ClientNotificationIntent,
  ClientRun,
  ClientTurnEvent,
  ClientTurnResponse,
} from "@frockbot/client-core";
import type {
  BotNotificationIntent,
  BotTurnCompletion,
  StoredRun,
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
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const CLIENT_RUN_PAGE_LIMIT = 32;
export const CLIENT_RUN_LIST_MAX_BYTES = 512_000;

export type ClientRunStatusV1 =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "reconciliation-required";

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
    };

export type ClientRunOutcomeV1 =
  { type: "completed"; text: string } | { type: "failed"; message: string };

export interface ClientRunRecoveryV1 {
  action: "resume";
  message: string;
}

export interface ClientRunV1 {
  schemaVersion: 1;
  runId: string;
  admittedAt: string;
  input: string;
  status: ClientRunStatusV1;
  events: ClientRunEventV1[];
  outcome?: ClientRunOutcomeV1;
  recovery?: ClientRunRecoveryV1;
}

export interface ClientRunPageV1 {
  truncated: boolean;
  nextCursor?: string;
}

export interface ClientRunListV1 {
  schemaVersion: 1;
  runs: ClientRunV1[];
  page: ClientRunPageV1;
}

export interface ClientRunListQueryV1 {
  schemaVersion: 1;
  before?: string;
}

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

type ClientToolCallV1 = Extract<ClientRunEventV1, { type: "tool/call" }>;
type ClientToolResultV1 = Extract<ClientRunEventV1, { type: "tool/result" }>;

interface ToolInteractionV1 {
  call: ClientToolCallV1;
  result?: ClientToolResultV1;
}

function toolInteractions(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ToolInteractionV1[] {
  const interactions: ToolInteractionV1[] = [];
  const byOccurrence = new Map<string, ToolInteractionV1>();
  for (const event of events) {
    if (event.type === "tool/call") {
      if (byOccurrence.has(event.occurrenceId)) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate intent`,
        );
      }
      const alias = `tool-${interactions.length + 1}`;
      const interaction: ToolInteractionV1 = {
        call: {
          type: "tool/call",
          call: {
            id: alias,
            name: truncateWireString(event.name, MAX_EVENT_NAME_BYTES),
          },
        },
      };
      interactions.push(interaction);
      byOccurrence.set(event.occurrenceId, interaction);
    } else if (event.type === "tool/result") {
      const interaction = byOccurrence.get(event.occurrenceId);
      if (!interaction) {
        throw new Error(
          `tool result has no matching occurrence "${event.occurrenceId}"`,
        );
      }
      if (interaction.result) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate results`,
        );
      }
      interaction.result = {
        type: "tool/result",
        callId: interaction.call.call.id,
        content: truncateWireString(event.content, MAX_EVENT_CONTENT_BYTES),
        isError: event.isError,
      };
    }
  }
  if (status === "completed" || status === "failed") {
    const orphaned = interactions.find((interaction) => !interaction.result);
    if (orphaned) {
      throw new Error(
        `terminal run has no result for tool call "${orphaned.call.call.id}"`,
      );
    }
  }
  return interactions;
}

function visibleEvents(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ClientRunEventV1[] {
  const interactions = toolInteractions(events, status);
  const completed = interactions.filter(
    (
      interaction,
    ): interaction is ToolInteractionV1 & {
      result: ClientToolResultV1;
    } => Boolean(interaction.result),
  );
  const pending = interactions.filter((interaction) => !interaction.result);
  const projectedSize = completed.length * 2 + pending.length;
  const completeProjection = [
    ...completed.flatMap((interaction) => [
      interaction.call,
      interaction.result,
    ]),
    ...pending.map((interaction) => interaction.call),
  ];
  if (
    projectedSize <= MAX_VISIBLE_EVENTS &&
    wireBytes(completeProjection) <= MAX_VISIBLE_EVENT_BYTES
  ) {
    return completeProjection;
  }
  if (pending.length >= MAX_VISIBLE_EVENTS) {
    throw new Error("run has too many pending tool interactions to project");
  }
  let retainedCompletedCount = Math.min(
    completed.length,
    Math.floor((MAX_VISIBLE_EVENTS - 1 - pending.length) / 2),
  );
  let omittedInteractions = completed.length - retainedCompletedCount;
  const buildProjection = (): ClientRunEventV1[] => {
    const retainedCompleted =
      retainedCompletedCount === 0
        ? []
        : completed.slice(-retainedCompletedCount);
    return [
      { type: "run/events-truncated", omittedInteractions },
      ...retainedCompleted.flatMap((interaction) => [
        interaction.call,
        interaction.result,
      ]),
      ...pending.map((interaction) => interaction.call),
    ];
  };
  let projection = buildProjection();
  while (
    retainedCompletedCount > 0 &&
    wireBytes(projection) > MAX_VISIBLE_EVENT_BYTES
  ) {
    retainedCompletedCount -= 1;
    omittedInteractions += 1;
    projection = buildProjection();
  }
  if (wireBytes(projection) > MAX_VISIBLE_EVENT_BYTES) {
    throw new Error("pending tool interactions exceed the wire byte limit");
  }
  return projection;
}

function runStatus(run: StoredRun): ClientRunStatusV1 {
  return run.status ?? "failed";
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
    schemaVersion: 1,
    runId: truncate(run.runId, MAX_RUN_ID_LENGTH),
    admittedAt: truncate(run.acceptedAt, MAX_TIMESTAMP_LENGTH),
    input: truncateWireString(run.input, MAX_INPUT_BYTES),
    status,
    events: visibleEvents(run.events, status),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
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
): ClientRunListV1 {
  return { schemaVersion: 1, runs, page };
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
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${label}.${unexpected} is not allowed`);
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
    value !== "interrupted" &&
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
    if (runStatus === "completed" || runStatus === "failed") {
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
    if (runStatus === "completed" || runStatus === "failed") {
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
      "outcome",
      "recovery",
    ],
    "run",
  );
  if (run.schemaVersion !== 1) throw new Error("run.schemaVersion is invalid");
  const runId = string(run, "runId", MAX_RUN_ID_LENGTH, "run");
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("run.runId is invalid");
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
  return {
    runId,
    admittedAt,
    input: wireString(run, "input", MAX_INPUT_BYTES, "run"),
    status: runStatus,
    events: decodeEvents(run.events, runStatus),
    ...(outcome?.type === "completed" ? { responseText: outcome.text } : {}),
    ...(outcome?.type === "failed" ? { failure: outcome.message } : {}),
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
      : string(page, "nextCursor", MAX_CURSOR_LENGTH, "run list.page");
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
  const runId = string(turn, "runId", MAX_RUN_ID_LENGTH, "turn");
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("turn.runId is invalid");
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
  if (before !== undefined && before.length === 0) {
    throw new Error("run list query.before must not be empty");
  }
  return { schemaVersion: 1, ...(before ? { before } : {}) };
}

export function decodeClientRunPageV1(input: unknown): {
  runs: ClientRun[];
  page: ClientRunPageV1;
} {
  const list = record(input, "run list");
  exactKeys(list, ["schemaVersion", "runs", "page"], "run list");
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
  const decoded = {
    runs: list.runs.map(decodeRun),
    page: decodePage(list.page),
  };
  return decoded;
}

export function decodeClientRunListV1(input: unknown): ClientRun[] {
  return decodeClientRunPageV1(input).runs;
}
