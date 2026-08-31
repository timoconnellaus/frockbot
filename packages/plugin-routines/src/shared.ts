// The Routines DTOs and commands: everything that crosses a runtime seam.
//
// "Cross-runtime communication uses narrow, versioned DTOs, and every inbound
// value is decoded at its seam." This module holds the wire shapes and their
// decoders and nothing else — no storage, no cron parsing (so the client bundle
// never carries a scheduler), and no key material of any kind.
//
// A `RoutineViewV1` never carries a webhook key or its digest. The key is minted
// once and shown once (D3); a listing is not a place to re-read a secret from.
import { canonicalCommandFingerprintV1 } from "@frockbot/configuration-core";
import {
  decodeRoutineTriggerV1,
  isRoutineIdV1,
  requireScheduleXorTriggerV1,
  RoutineDecodeError,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
  ROUTINE_RUN_STATUSES,
  ROUTINE_SCHEDULE_MAX,
  ROUTINE_TIMEZONE_MAX,
  ROUTINE_TRIGGER_KINDS,
  routineExactKeys,
  routineText,
  routineTimestamp,
  type RoutineRunStatusV1,
  type RoutineTriggerKindV1,
  type RoutineTriggerV1,
} from "./records.js";

export {
  RoutineDecodeError,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
  ROUTINE_RUN_STATUSES,
  ROUTINE_TRIGGER_KINDS,
} from "./records.js";
export type {
  RoutineRunStatusV1,
  RoutineTriggerKindV1,
  RoutineTriggerV1,
  RoutineWriterV1,
} from "./records.js";

/** Most Routines one listing carries. */
export const ROUTINE_LIST_MAX = 100;
/** Most run-log entries one listing carries. */
export const ROUTINE_RUN_LIST_MAX = 50;

/**
 * Who wrote a Routine, as the client is told it. The Session and Turn a Bot
 * writer records stay in the durable record: the UI needs to say "the Bot wrote
 * this", not to replay the Turn that did.
 */
export type RoutineWriterViewV1 =
  { kind: "user" } | { kind: "bot"; botId: string };

/** One Routine as the hosted client sees it. Never any key material. */
export interface RoutineViewV1 {
  schemaVersion: 1;
  routineId: string;
  name: string;
  prompt: string;
  schedule?: string;
  trigger?: RoutineTriggerV1;
  timezone: string;
  enabled: boolean;
  createdBy: RoutineWriterViewV1;
  updatedBy: RoutineWriterViewV1;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface RoutineListViewV1 {
  schemaVersion: 1;
  botId: string;
  routines: RoutineViewV1[];
}

/** One firing as the hosted client sees it. */
export interface RoutineRunEntryViewV1 {
  schemaVersion: 1;
  entryId: string;
  runId: string;
  trigger: RoutineTriggerKindV1;
  status: RoutineRunStatusV1;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

export interface RoutineRunListViewV1 {
  schemaVersion: 1;
  botId: string;
  routineId: string;
  entries: RoutineRunEntryViewV1[];
}

interface RoutineCommandMetaV1 {
  schemaVersion: 1;
  commandId: string;
  botId: string;
}

/**
 * The Routine commands. They are Bot configuration commands in every sense that
 * matters: one durable idempotency key per command, a fingerprint that makes a
 * replay of the same key with different bytes an error, and one authority that
 * applies them. They carry no `expectedRevision` because a Routine is its own
 * durable record rather than a field of the Bot settings view — an unrelated
 * profile edit must not make a Routine write conflict, and the reverse.
 */
export type RoutineCommandV1 =
  | (RoutineCommandMetaV1 & {
      type: "routine/create";
      routineId?: string;
      name: string;
      prompt: string;
      schedule?: string;
      trigger?: RoutineTriggerV1;
      timezone?: string;
    })
  | (RoutineCommandMetaV1 & {
      /** Partial: only the fields the command carries change. */
      type: "routine/update";
      routineId: string;
      name?: string;
      prompt?: string;
      schedule?: string;
      trigger?: RoutineTriggerV1;
      timezone?: string;
      enabled?: boolean;
    })
  | (RoutineCommandMetaV1 & { type: "routine/pause"; routineId: string })
  | (RoutineCommandMetaV1 & { type: "routine/resume"; routineId: string })
  | (RoutineCommandMetaV1 & { type: "routine/delete"; routineId: string });

export type RoutineCommandTypeV1 = RoutineCommandV1["type"];

export const ROUTINE_COMMAND_TYPES: readonly RoutineCommandTypeV1[] = [
  "routine/create",
  "routine/update",
  "routine/pause",
  "routine/resume",
  "routine/delete",
];

export type RoutineCommandReceiptV1 =
  | {
      schemaVersion: 1;
      commandId: string;
      status: "applied";
      routine: RoutineViewV1;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "deleted";
      routineId: string;
    };

/**
 * The idempotency fingerprint of a Routine command: the same canonicalization
 * `configurationCommandFingerprintV1` uses, under its own namespace, so a
 * Routine command and a settings command can never collide.
 */
export function routineCommandFingerprintV1(command: RoutineCommandV1): string {
  const { commandId: _commandId, ...semantic } = command;
  return canonicalCommandFingerprintV1("routine-command-v1", semantic);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function commandIdentifier(value: unknown, label: string): string {
  if (!isRoutineIdV1(value)) {
    throw new RoutineDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeRoutineCommandV1(value: unknown): RoutineCommandV1 {
  const candidate = record(value, "Routine command");
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine command schemaVersion is unsupported",
    );
  }
  const type = ROUTINE_COMMAND_TYPES.find((known) => known === candidate.type);
  if (!type) {
    throw new RoutineDecodeError("Routine command type is unknown");
  }
  const meta: RoutineCommandMetaV1 = {
    schemaVersion: 1,
    commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
    botId: commandIdentifier(candidate.botId, "Routine command botId"),
  };
  if (type === "routine/create") {
    routineExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "name", "prompt"],
      ["routineId", "schedule", "trigger", "timezone"],
      "routine/create",
    );
    const created = {
      ...meta,
      type,
      name: routineText(
        candidate.name,
        ROUTINE_NAME_MAX_LENGTH,
        "Routine name",
      ),
      prompt: routineText(
        candidate.prompt,
        ROUTINE_PROMPT_MAX_LENGTH,
        "Routine prompt",
      ),
      ...(candidate.routineId === undefined
        ? {}
        : {
            routineId: commandIdentifier(candidate.routineId, "Routine id"),
          }),
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
      ...(candidate.timezone === undefined
        ? {}
        : {
            timezone: routineText(
              candidate.timezone,
              ROUTINE_TIMEZONE_MAX,
              "Routine timezone",
            ),
          }),
    } satisfies Extract<RoutineCommandV1, { type: "routine/create" }>;
    requireScheduleXorTriggerV1(created);
    return created;
  }
  if (type === "routine/update") {
    routineExactKeys(
      candidate,
      ["schemaVersion", "type", "commandId", "botId", "routineId"],
      ["name", "prompt", "schedule", "trigger", "timezone", "enabled"],
      "routine/update",
    );
    if (candidate.schedule !== undefined && candidate.trigger !== undefined) {
      throw new RoutineDecodeError(
        "a Routine carries a schedule or a trigger, never both",
      );
    }
    if (
      candidate.enabled !== undefined &&
      typeof candidate.enabled !== "boolean"
    ) {
      throw new RoutineDecodeError("routine/update enabled must be a boolean");
    }
    const patched = {
      ...meta,
      type,
      routineId: commandIdentifier(candidate.routineId, "Routine id"),
      ...(candidate.name === undefined
        ? {}
        : {
            name: routineText(
              candidate.name,
              ROUTINE_NAME_MAX_LENGTH,
              "Routine name",
            ),
          }),
      ...(candidate.prompt === undefined
        ? {}
        : {
            prompt: routineText(
              candidate.prompt,
              ROUTINE_PROMPT_MAX_LENGTH,
              "Routine prompt",
            ),
          }),
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
      ...(candidate.timezone === undefined
        ? {}
        : {
            timezone: routineText(
              candidate.timezone,
              ROUTINE_TIMEZONE_MAX,
              "Routine timezone",
            ),
          }),
      ...(candidate.enabled === undefined
        ? {}
        : { enabled: candidate.enabled as boolean }),
    } satisfies Extract<RoutineCommandV1, { type: "routine/update" }>;
    const changes = Object.keys(patched).filter(
      (key) =>
        key !== "schemaVersion" &&
        key !== "type" &&
        key !== "commandId" &&
        key !== "botId" &&
        key !== "routineId",
    );
    if (changes.length === 0) {
      throw new RoutineDecodeError("routine/update changes nothing");
    }
    return patched;
  }
  routineExactKeys(
    candidate,
    ["schemaVersion", "type", "commandId", "botId", "routineId"],
    [],
    type,
  );
  return {
    ...meta,
    type,
    routineId: commandIdentifier(candidate.routineId, "Routine id"),
  };
}

function decodeRoutineWriterViewV1(
  value: unknown,
  label: string,
): RoutineWriterViewV1 {
  const candidate = record(value, label);
  if (candidate.kind === "user") {
    routineExactKeys(candidate, ["kind"], [], label);
    return { kind: "user" };
  }
  if (candidate.kind !== "bot") {
    throw new RoutineDecodeError(`${label} kind is invalid`);
  }
  routineExactKeys(candidate, ["kind", "botId"], [], label);
  return {
    kind: "bot",
    botId: routineText(candidate.botId, 128, `${label} botId`),
  };
}

export function decodeRoutineViewV1(value: unknown): RoutineViewV1 {
  const candidate = record(value, "Routine view");
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
    "Routine view",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError("Routine view schemaVersion is unsupported");
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new RoutineDecodeError("Routine view enabled must be a boolean");
  }
  const view: RoutineViewV1 = {
    schemaVersion: 1,
    routineId: commandIdentifier(candidate.routineId, "Routine view routineId"),
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
    createdBy: decodeRoutineWriterViewV1(
      candidate.createdBy,
      "Routine createdBy",
    ),
    updatedBy: decodeRoutineWriterViewV1(
      candidate.updatedBy,
      "Routine updatedBy",
    ),
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
  requireScheduleXorTriggerV1(view);
  return view;
}

export function decodeRoutineListViewV1(value: unknown): RoutineListViewV1 {
  const candidate = record(value, "Routine list");
  routineExactKeys(
    candidate,
    ["schemaVersion", "botId", "routines"],
    [],
    "Routine list",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError("Routine list schemaVersion is unsupported");
  }
  if (!Array.isArray(candidate.routines)) {
    throw new RoutineDecodeError("Routine list routines must be an array");
  }
  if (candidate.routines.length > ROUTINE_LIST_MAX) {
    throw new RoutineDecodeError("Routine list is over its bound");
  }
  return {
    schemaVersion: 1,
    botId: commandIdentifier(candidate.botId, "Routine list botId"),
    routines: candidate.routines.map(decodeRoutineViewV1),
  };
}

export function decodeRoutineRunEntryViewV1(
  value: unknown,
): RoutineRunEntryViewV1 {
  const candidate = record(value, "Routine run entry view");
  routineExactKeys(
    candidate,
    ["schemaVersion", "entryId", "runId", "trigger", "status", "startedAt"],
    ["finishedAt", "summary"],
    "Routine run entry view",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine run entry view schemaVersion is unsupported",
    );
  }
  const status = ROUTINE_RUN_STATUSES.find(
    (known) => known === candidate.status,
  );
  const trigger = ROUTINE_TRIGGER_KINDS.find(
    (known) => known === candidate.trigger,
  );
  if (!status) {
    throw new RoutineDecodeError("Routine run entry view status is invalid");
  }
  if (!trigger) {
    throw new RoutineDecodeError("Routine run entry view trigger is invalid");
  }
  return {
    schemaVersion: 1,
    entryId: routineText(candidate.entryId, 128, "Routine run entryId"),
    runId: routineText(candidate.runId, 256, "Routine run runId"),
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

export function decodeRoutineRunListViewV1(
  value: unknown,
): RoutineRunListViewV1 {
  const candidate = record(value, "Routine run list");
  routineExactKeys(
    candidate,
    ["schemaVersion", "botId", "routineId", "entries"],
    [],
    "Routine run list",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine run list schemaVersion is unsupported",
    );
  }
  if (!Array.isArray(candidate.entries)) {
    throw new RoutineDecodeError("Routine run list entries must be an array");
  }
  if (candidate.entries.length > ROUTINE_RUN_LIST_MAX) {
    throw new RoutineDecodeError("Routine run list is over its bound");
  }
  return {
    schemaVersion: 1,
    botId: commandIdentifier(candidate.botId, "Routine run list botId"),
    routineId: commandIdentifier(
      candidate.routineId,
      "Routine run list routineId",
    ),
    entries: candidate.entries.map(decodeRoutineRunEntryViewV1),
  };
}

export function decodeRoutineCommandReceiptV1(
  value: unknown,
): RoutineCommandReceiptV1 {
  const candidate = record(value, "Routine command receipt");
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine command receipt schemaVersion is unsupported",
    );
  }
  if (candidate.status === "deleted") {
    routineExactKeys(
      candidate,
      ["schemaVersion", "commandId", "status", "routineId"],
      [],
      "Routine command receipt",
    );
    return {
      schemaVersion: 1,
      commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
      status: "deleted",
      routineId: commandIdentifier(candidate.routineId, "Routine id"),
    };
  }
  if (candidate.status !== "applied") {
    throw new RoutineDecodeError("Routine command receipt status is invalid");
  }
  routineExactKeys(
    candidate,
    ["schemaVersion", "commandId", "status", "routine"],
    [],
    "Routine command receipt",
  );
  return {
    schemaVersion: 1,
    commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
    status: "applied",
    routine: decodeRoutineViewV1(candidate.routine),
  };
}
