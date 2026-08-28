import type { SessionEvent } from "@frockbot/agent-core";
import type {
  ClientRun,
  ClientTurnEvent,
} from "@frockbot/client-core";
import type { StoredRun } from "./backend-contracts.js";

const MAX_RUN_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_INPUT_LENGTH = 32_000;
const MAX_OUTCOME_LENGTH = 256_000;
const MAX_FAILURE_LENGTH = 8_000;
const MAX_VISIBLE_EVENTS = 512;
const MAX_EVENT_ID_LENGTH = 256;
const MAX_EVENT_NAME_LENGTH = 256;
const MAX_EVENT_CONTENT_LENGTH = 32_000;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

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
  | { type: "completed"; text: string }
  | { type: "failed"; message: string };

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

export interface ClientRunListV1 {
  schemaVersion: 1;
  runs: ClientRunV1[];
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function eventId(value: string, label: string): string {
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
  const interactions = new Map<string, ToolInteractionV1>();
  for (const event of events) {
    if (event.type === "tool/call") {
      const id = eventId(event.call.id, "tool call id");
      if (interactions.has(id)) {
        throw new Error(`tool interaction "${id}" has a duplicate call`);
      }
      interactions.set(id, {
        call: {
          type: "tool/call",
          call: {
            id,
            name: truncate(event.call.name, MAX_EVENT_NAME_LENGTH),
          },
        },
      });
    } else if (event.type === "tool/result") {
      const id = eventId(event.callId, "tool result call id");
      const interaction = interactions.get(id);
      if (!interaction) {
        throw new Error(`tool result "${id}" has no matching call`);
      }
      if (interaction.result) {
        throw new Error(`tool interaction "${id}" has duplicate results`);
      }
      interaction.result = {
        type: "tool/result",
        callId: id,
        content: truncate(event.content, MAX_EVENT_CONTENT_LENGTH),
        isError: event.isError,
      };
    }
  }
  const projected = [...interactions.values()];
  if (status === "completed" || status === "failed") {
    const orphaned = projected.find((interaction) => !interaction.result);
    if (orphaned) {
      throw new Error(
        `terminal run has no result for tool call "${orphaned.call.call.id}"`,
      );
    }
  }
  return projected;
}

function visibleEvents(
  events: readonly SessionEvent[],
  status: ClientRunStatusV1,
): ClientRunEventV1[] {
  const interactions = toolInteractions(events, status);
  const completed = interactions.filter(
    (interaction): interaction is ToolInteractionV1 & {
      result: ClientToolResultV1;
    } => Boolean(interaction.result),
  );
  const pending = interactions.filter((interaction) => !interaction.result);
  const projectedSize = completed.length * 2 + pending.length;
  if (projectedSize <= MAX_VISIBLE_EVENTS) {
    return [
      ...completed.flatMap((interaction) => [
        interaction.call,
        interaction.result,
      ]),
      ...pending.map((interaction) => interaction.call),
    ];
  }
  if (pending.length >= MAX_VISIBLE_EVENTS) {
    throw new Error("run has too many pending tool interactions to project");
  }
  const retainedCompletedCount = Math.floor(
    (MAX_VISIBLE_EVENTS - 1 - pending.length) / 2,
  );
  const omittedInteractions = completed.length - retainedCompletedCount;
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
          text: truncate(run.responseText ?? "", MAX_OUTCOME_LENGTH),
        } satisfies ClientRunOutcomeV1)
      : status === "failed"
        ? ({
            type: "failed",
            message: truncate(
              run.failure ?? "Agent request failed.",
              MAX_FAILURE_LENGTH,
            ),
          } satisfies ClientRunOutcomeV1)
        : undefined;
  const recovery =
    status === "reconciliation-required"
      ? ({
          action: "resume",
          message: truncate(
            run.failure ??
              "Provider reconciliation is required before this Turn can continue.",
            MAX_FAILURE_LENGTH,
          ),
        } satisfies ClientRunRecoveryV1)
      : undefined;
  return {
    schemaVersion: 1,
    runId: truncate(run.runId, MAX_RUN_ID_LENGTH),
    admittedAt: truncate(run.acceptedAt, MAX_TIMESTAMP_LENGTH),
    input: truncate(run.input, MAX_INPUT_LENGTH),
    status,
    events: visibleEvents(run.events, status),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

export function projectClientRunListV1(
  runs: readonly StoredRun[],
): ClientRunListV1 {
  return { schemaVersion: 1, runs: runs.map(projectClientRunV1) };
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
        id: eventId(
          string(call, "id", MAX_EVENT_ID_LENGTH, "run event.call"),
          "run event.call.id",
        ),
        name: string(call, "name", MAX_EVENT_NAME_LENGTH, "run event.call"),
      },
    };
  }
  if (event.type === "tool/result") {
    exactKeys(
      event,
      ["type", "callId", "content", "isError"],
      "run event",
    );
    if (typeof event.isError !== "boolean") {
      throw new Error("run event.isError must be a boolean");
    }
    return {
      type: "tool/result",
      callId: eventId(
        string(event, "callId", MAX_EVENT_ID_LENGTH, "run event"),
        "run event.callId",
      ),
      content: string(
        event,
        "content",
        MAX_EVENT_CONTENT_LENGTH,
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
    events
      .slice(index)
      .some((event) => event.type === "run/events-truncated")
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
      text: string(outcome, "text", MAX_OUTCOME_LENGTH, "run.outcome"),
    };
  }
  if (outcome.type === "failed" && runStatus === "failed") {
    exactKeys(outcome, ["type", "message"], "run.outcome");
    return {
      type: "failed",
      message: string(
        outcome,
        "message",
        MAX_FAILURE_LENGTH,
        "run.outcome",
      ),
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
    message: string(
      recovery,
      "message",
      MAX_FAILURE_LENGTH,
      "run.recovery",
    ),
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
  const admittedAt = string(
    run,
    "admittedAt",
    MAX_TIMESTAMP_LENGTH,
    "run",
  );
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
    input: string(run, "input", MAX_INPUT_LENGTH, "run"),
    status: runStatus,
    events: decodeEvents(run.events, runStatus),
    ...(outcome?.type === "completed" ? { responseText: outcome.text } : {}),
    ...(outcome?.type === "failed" ? { failure: outcome.message } : {}),
    ...(recovery ? { failure: recovery.message, recovery } : {}),
  };
}

export function decodeClientRunListV1(input: unknown): ClientRun[] {
  const list = record(input, "run list");
  exactKeys(list, ["schemaVersion", "runs"], "run list");
  if (list.schemaVersion !== 1) {
    throw new Error("run list.schemaVersion is invalid");
  }
  if (!Array.isArray(list.runs)) {
    throw new Error("run list.runs must be an array");
  }
  return list.runs.map(decodeRun);
}
