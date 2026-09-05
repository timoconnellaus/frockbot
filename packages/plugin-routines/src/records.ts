import {
  decodeConnectionTriggerV1,
  type ConnectionTriggerV1,
} from "@frockbot/connection-core";
// The durable Routine records, and their strict codecs.
//
// Every record is versioned, exact-field, and decoded at the seam it crosses.
// A previous stored shape must cross an explicit forward migration here before
// strict decoding; an unknown shape remains a visible failure.
//
// A webhook Routine's record names the trigger *kind* and nothing else. Key
// material is minted, stored, and verified elsewhere (D3) and never reaches a
// record a view is projected from.

/** Longest values a Routine record may carry. */
export const ROUTINE_NAME_MAX_LENGTH = 100;
export const ROUTINE_PROMPT_MAX_LENGTH = 8_000;
export const ROUTINE_SCHEDULE_MAX = 256;
export const ROUTINE_TIMEZONE_MAX = 64;
export const ROUTINE_ID_MAX = 128;

/** The statuses one entry of a Routine's run log may hold. */
export const ROUTINE_RUN_STATUSES = [
  "running",
  "ok",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type RoutineRunStatusV1 = (typeof ROUTINE_RUN_STATUSES)[number];

/** What produced a firing. Mirrors `StoredRunOriginV1.trigger` exactly. */
export const ROUTINE_TRIGGER_KINDS = [
  "cron",
  "webhook",
  "integration",
  "manual",
] as const;

export type RoutineTriggerKindV1 = (typeof ROUTINE_TRIGGER_KINDS)[number];

/**
 * Who wrote a Routine. "Every write to a durable root records its writer" — a
 * Routine is durable Bot state authored by a User or by the Bot itself, so the
 * same rule binds, and a Bot writer names the Session and Turn that produced it.
 */
export type RoutineWriterV1 =
  | { kind: "user" }
  | { kind: "bot"; botId: string; sessionId: string; turnId: string };

/** A Routine that fires on a delivered event rather than on a clock. */
export type RoutineTriggerV1 =
  { kind: "webhook" } | ({ kind: "connection" } & ConnectionTriggerV1);

/**
 * One Routine. `schedule` and `trigger` are exclusive: "never both `schedule`
 * and `trigger`", and never neither.
 */
export interface RoutineRecordV1 {
  schemaVersion: 1;
  routineId: string;
  name: string;
  prompt: string;
  schedule?: string;
  trigger?: RoutineTriggerV1;
  timezone: string;
  enabled: boolean;
  createdBy: RoutineWriterV1;
  updatedBy: RoutineWriterV1;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

/** One entry of a Routine's bounded run log. */
export interface RoutineRunEntryV1 {
  schemaVersion: 1;
  entryId: string;
  routineId: string;
  runId: string;
  fireId: string;
  trigger: RoutineTriggerKindV1;
  status: RoutineRunStatusV1;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

export class RoutineDecodeError extends Error {
  override readonly name = "RoutineDecodeError";
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isRoutineIdV1(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function routineExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RoutineDecodeError(`${label} has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new RoutineDecodeError(`${label} is missing "${key}"`);
    }
  }
}

export function routineText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new RoutineDecodeError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RoutineDecodeError(`${label} must not be empty`);
  }
  if (trimmed.length > maximum) {
    throw new RoutineDecodeError(
      `${label} must be at most ${maximum} characters`,
    );
  }
  return trimmed;
}

export function routineTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RoutineDecodeError(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function decodeRoutineWriterV1(
  value: unknown,
  label = "Routine writer",
): RoutineWriterV1 {
  const candidate = record(value, label);
  if (candidate.kind === "user") {
    routineExactKeys(candidate, ["kind"], [], label);
    return { kind: "user" };
  }
  if (candidate.kind !== "bot") {
    throw new RoutineDecodeError(`${label} kind is invalid`);
  }
  routineExactKeys(
    candidate,
    ["kind", "botId", "sessionId", "turnId"],
    [],
    label,
  );
  return {
    kind: "bot",
    botId: routineText(candidate.botId, 128, `${label} botId`),
    sessionId: routineText(candidate.sessionId, 256, `${label} sessionId`),
    turnId: routineText(candidate.turnId, 256, `${label} turnId`),
  };
}

export function decodeRoutineTriggerV1(
  value: unknown,
  label = "Routine trigger",
): RoutineTriggerV1 {
  const candidate = record(value, label);
  if (candidate.kind === "connection") {
    routineExactKeys(
      candidate,
      ["kind", "connectionId", "triggerType", "config"],
      [],
      label,
    );
    try {
      return {
        kind: "connection",
        ...decodeConnectionTriggerV1({
          connectionId: candidate.connectionId,
          triggerType: candidate.triggerType,
          config: candidate.config,
        }),
      };
    } catch {
      throw new RoutineDecodeError(
        "Choose an available event from an existing connection",
      );
    }
  }
  routineExactKeys(candidate, ["kind"], [], label);
  if (candidate.kind !== "webhook") {
    throw new RoutineDecodeError(
      `${label} kind must be "webhook" or "connection"`,
    );
  }
  return { kind: "webhook" };
}

/**
 * Exactly one of `schedule` and `trigger`. This is the rule GrokBot states and
 * the one the whole scheduler rests on, so it is enforced in the codec rather
 * than at a call site that might be skipped.
 */
export function requireScheduleXorTriggerV1(input: {
  schedule?: string;
  trigger?: RoutineTriggerV1;
}): void {
  const hasSchedule = input.schedule !== undefined;
  const hasTrigger = input.trigger !== undefined;
  if (hasSchedule && hasTrigger) {
    throw new RoutineDecodeError(
      "a Routine carries a schedule or a trigger, never both",
    );
  }
  if (!hasSchedule && !hasTrigger) {
    throw new RoutineDecodeError("a Routine needs a schedule or a trigger");
  }
}

export function decodeRoutineRecordV1(value: unknown): RoutineRecordV1 {
  const candidate = record(value, "Routine record");
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "routineId",
      "name",
      "prompt",
      "timezone",
      "enabled",
      "createdBy",
      "updatedBy",
      "createdAt",
      "updatedAt",
    ],
    ["schedule", "trigger", "lastRunAt"],
    "Routine record",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError("Routine record schemaVersion is unsupported");
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine record routineId is invalid");
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new RoutineDecodeError("Routine record enabled must be a boolean");
  }
  const decoded: RoutineRecordV1 = {
    schemaVersion: 1,
    routineId: candidate.routineId,
    name: routineText(candidate.name, ROUTINE_NAME_MAX_LENGTH, "Routine name"),
    prompt: routineText(
      candidate.prompt,
      ROUTINE_PROMPT_MAX_LENGTH,
      "Routine prompt",
    ),
    timezone: routineText(
      candidate.timezone,
      ROUTINE_TIMEZONE_MAX,
      "Routine timezone",
    ),
    enabled: candidate.enabled,
    createdBy: decodeRoutineWriterV1(candidate.createdBy, "Routine createdBy"),
    updatedBy: decodeRoutineWriterV1(candidate.updatedBy, "Routine updatedBy"),
    createdAt: routineTimestamp(candidate.createdAt, "Routine createdAt"),
    updatedAt: routineTimestamp(candidate.updatedAt, "Routine updatedAt"),
    ...(candidate.schedule === undefined
      ? {}
      : {
          schedule: routineText(
            candidate.schedule,
            ROUTINE_SCHEDULE_MAX,
            "Routine schedule",
          ),
        }),
    ...(candidate.trigger === undefined
      ? {}
      : { trigger: decodeRoutineTriggerV1(candidate.trigger) }),
    ...(candidate.lastRunAt === undefined
      ? {}
      : {
          lastRunAt: routineTimestamp(candidate.lastRunAt, "Routine lastRunAt"),
        }),
  };
  requireScheduleXorTriggerV1(decoded);
  return decoded;
}

export function decodeRoutineRunEntryV1(value: unknown): RoutineRunEntryV1 {
  const candidate = record(value, "Routine run entry");
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "entryId",
      "routineId",
      "runId",
      "fireId",
      "trigger",
      "status",
      "startedAt",
    ],
    ["finishedAt", "summary"],
    "Routine run entry",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine run entry schemaVersion is unsupported",
    );
  }
  const status = ROUTINE_RUN_STATUSES.find(
    (known) => known === candidate.status,
  );
  if (!status) {
    throw new RoutineDecodeError("Routine run entry status is invalid");
  }
  const trigger = ROUTINE_TRIGGER_KINDS.find(
    (known) => known === candidate.trigger,
  );
  if (!trigger) {
    throw new RoutineDecodeError("Routine run entry trigger is invalid");
  }
  if (!isRoutineIdV1(candidate.routineId)) {
    throw new RoutineDecodeError("Routine run entry routineId is invalid");
  }
  return {
    schemaVersion: 1,
    entryId: routineText(candidate.entryId, 128, "Routine run entryId"),
    routineId: candidate.routineId,
    runId: routineText(candidate.runId, 256, "Routine run runId"),
    fireId: routineText(candidate.fireId, 256, "Routine run fireId"),
    trigger,
    status,
    startedAt: routineTimestamp(candidate.startedAt, "Routine run startedAt"),
    ...(candidate.finishedAt === undefined
      ? {}
      : {
          finishedAt: routineTimestamp(
            candidate.finishedAt,
            "Routine run finishedAt",
          ),
        }),
    ...(candidate.summary === undefined
      ? {}
      : {
          summary: routineText(candidate.summary, 2_000, "Routine run summary"),
        }),
  };
}
