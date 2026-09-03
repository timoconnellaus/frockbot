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

/**
 * The one path a webhook delivery is made to. It is built here so the route
 * that answers it and the receipt that advertises it cannot drift apart.
 */
export function routineHookPathV1(botId: string, routineId: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/hook`;
}

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
  /**
   * When the scheduler will next fire this Routine. Absent for a webhook
   * Routine, and for a paused one: the UI shows what the authority promised and
   * nothing else.
   */
  nextRunAt?: string;
  /**
   * Whether a webhook key is live, and which version. Never the key, and never
   * its digest: the UI needs to say "a key exists", not to re-read one.
   */
  hookKeyVersion?: number;
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
  | (RoutineCommandMetaV1 & { type: "routine/delete"; routineId: string })
  /**
   * Fire now, out of band. It enqueues a firing rather than running one: the
   * caller may itself be a Turn in flight, and a Routine is never run in
   * parallel with anything. The alarm drains it.
   */
  | (RoutineCommandMetaV1 & { type: "routine/run"; routineId: string })
  /**
   * Mint a fresh webhook key, retiring the one before it. The plaintext key
   * comes back once, on the receipt, and is never stored or listed.
   */
  | (RoutineCommandMetaV1 & { type: "routine/rotate-key"; routineId: string })
  /** Retire the webhook key without minting another. Deliveries then 401. */
  | (RoutineCommandMetaV1 & { type: "routine/revoke-key"; routineId: string });

export type RoutineCommandTypeV1 = RoutineCommandV1["type"];

export const ROUTINE_COMMAND_TYPES: readonly RoutineCommandTypeV1[] = [
  "routine/create",
  "routine/update",
  "routine/pause",
  "routine/resume",
  "routine/delete",
  "routine/run",
  "routine/rotate-key",
  "routine/revoke-key",
];

/**
 * A freshly minted webhook key, handed back exactly once.
 *
 * It is on the receipt the caller receives and not on the receipt the Bot
 * stores: a key that could be re-read from durable state would not be a secret,
 * and a replayed command id therefore answers without one.
 */
export interface RoutineHookMintV1 {
  schemaVersion: 1;
  routineId: string;
  keyVersion: number;
  /** The plaintext key. Shown once; the Bot keeps only its digest. */
  token: string;
  /** The path the key is presented against, for the client to make a URL of. */
  path: string;
}

export type RoutineCommandReceiptV1 =
  | {
      schemaVersion: 1;
      commandId: string;
      status: "applied";
      routine: RoutineViewV1;
      hook?: RoutineHookMintV1;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "deleted";
      routineId: string;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "fired";
      routineId: string;
      /** The run id the firing will be admitted under. */
      fireId: string;
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

function hookKeyVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RoutineDecodeError("Routine view hookKeyVersion is invalid");
  }
  return value as number;
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
    ["schedule", "trigger", "lastRunAt", "nextRunAt", "hookKeyVersion"],
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
    ...(candidate.nextRunAt === undefined
      ? {}
      : {
          nextRunAt: routineTimestamp(candidate.nextRunAt, "Routine nextRunAt"),
        }),
    ...(candidate.hookKeyVersion === undefined
      ? {}
      : { hookKeyVersion: hookKeyVersion(candidate.hookKeyVersion) }),
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

export function decodeRoutineHookMintV1(value: unknown): RoutineHookMintV1 {
  const candidate = record(value, "Routine hook mint");
  routineExactKeys(
    candidate,
    ["schemaVersion", "routineId", "keyVersion", "token", "path"],
    [],
    "Routine hook mint",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine hook mint schemaVersion is unsupported",
    );
  }
  return {
    schemaVersion: 1,
    routineId: commandIdentifier(candidate.routineId, "Routine id"),
    keyVersion: hookKeyVersion(candidate.keyVersion),
    token: routineText(candidate.token, 2_048, "Routine hook token"),
    path: routineText(candidate.path, 512, "Routine hook path"),
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
  if (candidate.status === "fired") {
    routineExactKeys(
      candidate,
      ["schemaVersion", "commandId", "status", "routineId", "fireId"],
      [],
      "Routine command receipt",
    );
    return {
      schemaVersion: 1,
      commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
      status: "fired",
      routineId: commandIdentifier(candidate.routineId, "Routine id"),
      fireId: routineText(candidate.fireId, 256, "Routine fireId"),
    };
  }
  if (candidate.status !== "applied") {
    throw new RoutineDecodeError("Routine command receipt status is invalid");
  }
  routineExactKeys(
    candidate,
    ["schemaVersion", "commandId", "status", "routine"],
    ["hook"],
    "Routine command receipt",
  );
  return {
    schemaVersion: 1,
    commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
    status: "applied",
    routine: decodeRoutineViewV1(candidate.routine),
    ...(candidate.hook === undefined
      ? {}
      : { hook: decodeRoutineHookMintV1(candidate.hook) }),
  };
}

/** Most inbox entries one listing carries. */
export const ROUTINE_INBOX_LIST_MAX = 100;
/** Most events one automation run's read-only view carries. */
export const ROUTINE_RUN_EVENT_MAX = 200;

/** One completed automation Turn, as the hosted client sees it. */
export interface RoutineInboxEntryViewV1 {
  schemaVersion: 1;
  entryId: string;
  runId: string;
  routineId: string;
  text: string;
  attribution: string;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  /** How many firings this entry stands for; absent means one. */
  repeatCount?: number;
  /** The firing did not work. */
  failure?: true;
}

export interface RoutineInboxViewV1 {
  schemaVersion: 1;
  botId: string;
  entries: RoutineInboxEntryViewV1[];
  /** What the header badge shows, so the client counts nothing itself. */
  unacknowledged: number;
}

/**
 * Acknowledging is a command, never a side effect of reading: a background poll
 * must not clear a badge. An empty `entryIds` acknowledges every entry.
 */
export interface RoutineInboxCommandV1 {
  schemaVersion: 1;
  commandId: string;
  botId: string;
  type: "routine/acknowledge-inbox";
  entryIds: string[];
}

export interface RoutineInboxReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied";
  inbox: RoutineInboxViewV1;
}

/**
 * One event of an automation run, flattened for the run-log reader.
 *
 * An automation run is absent from the visible transcript by construction, so
 * the only way to read one is here — and it is a read, in a shape that carries
 * no tool inputs, no model requests and no payloads, only what happened.
 */
export interface RoutineRunEventViewV1 {
  type: string;
  at: string;
  summary: string;
}

/** One automation run, read-only, reachable only through the run log. */
export interface RoutineRunDetailViewV1 {
  schemaVersion: 1;
  botId: string;
  routineId: string;
  runId: string;
  status: string;
  admittedAt: string;
  input: string;
  events: RoutineRunEventViewV1[];
  outcome?: string;
}

export function decodeRoutineInboxEntryViewV1(
  value: unknown,
): RoutineInboxEntryViewV1 {
  const candidate = record(value, "Routine inbox entry view");
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "entryId",
      "runId",
      "routineId",
      "text",
      "attribution",
      "createdAt",
      "acknowledged",
    ],
    ["acknowledgedAt"],
    "Routine inbox entry view",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine inbox entry view schemaVersion is unsupported",
    );
  }
  if (typeof candidate.acknowledged !== "boolean") {
    throw new RoutineDecodeError(
      "Routine inbox entry view acknowledged must be a boolean",
    );
  }
  return {
    schemaVersion: 1,
    entryId: routineText(candidate.entryId, 256, "Routine inbox entryId"),
    runId: routineText(candidate.runId, 256, "Routine inbox runId"),
    routineId: commandIdentifier(
      candidate.routineId,
      "Routine inbox routineId",
    ),
    text: routineText(candidate.text, 4_000, "Routine inbox text"),
    attribution: routineText(
      candidate.attribution,
      128,
      "Routine inbox attribution",
    ),
    createdAt: routineTimestamp(candidate.createdAt, "Routine inbox createdAt"),
    acknowledged: candidate.acknowledged,
    ...(candidate.acknowledgedAt === undefined
      ? {}
      : {
          acknowledgedAt: routineTimestamp(
            candidate.acknowledgedAt,
            "Routine inbox acknowledgedAt",
          ),
        }),
  };
}

export function decodeRoutineInboxViewV1(value: unknown): RoutineInboxViewV1 {
  const candidate = record(value, "Routine inbox view");
  routineExactKeys(
    candidate,
    ["schemaVersion", "botId", "entries", "unacknowledged"],
    [],
    "Routine inbox view",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine inbox view schemaVersion is unsupported",
    );
  }
  if (!Array.isArray(candidate.entries)) {
    throw new RoutineDecodeError("Routine inbox view entries must be an array");
  }
  if (candidate.entries.length > ROUTINE_INBOX_LIST_MAX) {
    throw new RoutineDecodeError("Routine inbox view is over its bound");
  }
  if (
    !Number.isSafeInteger(candidate.unacknowledged) ||
    (candidate.unacknowledged as number) < 0
  ) {
    throw new RoutineDecodeError(
      "Routine inbox view unacknowledged must be a non-negative integer",
    );
  }
  return {
    schemaVersion: 1,
    botId: commandIdentifier(candidate.botId, "Routine inbox view botId"),
    entries: candidate.entries.map(decodeRoutineInboxEntryViewV1),
    unacknowledged: candidate.unacknowledged as number,
  };
}

export function decodeRoutineInboxCommandV1(
  value: unknown,
): RoutineInboxCommandV1 {
  const candidate = record(value, "Routine inbox command");
  routineExactKeys(
    candidate,
    ["schemaVersion", "commandId", "botId", "type", "entryIds"],
    [],
    "Routine inbox command",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine inbox command schemaVersion is unsupported",
    );
  }
  if (candidate.type !== "routine/acknowledge-inbox") {
    throw new RoutineDecodeError("Routine inbox command type is invalid");
  }
  if (!Array.isArray(candidate.entryIds)) {
    throw new RoutineDecodeError(
      "Routine inbox command entryIds must be an array",
    );
  }
  if (candidate.entryIds.length > ROUTINE_INBOX_LIST_MAX) {
    throw new RoutineDecodeError("Routine inbox command is over its bound");
  }
  return {
    schemaVersion: 1,
    commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
    botId: commandIdentifier(candidate.botId, "Routine inbox command botId"),
    type: "routine/acknowledge-inbox",
    entryIds: candidate.entryIds.map((entryId) =>
      routineText(entryId, 256, "Routine inbox command entryId"),
    ),
  };
}

export function decodeRoutineInboxReceiptV1(
  value: unknown,
): RoutineInboxReceiptV1 {
  const candidate = record(value, "Routine inbox receipt");
  routineExactKeys(
    candidate,
    ["schemaVersion", "commandId", "status", "inbox"],
    [],
    "Routine inbox receipt",
  );
  if (candidate.schemaVersion !== 1 || candidate.status !== "applied") {
    throw new RoutineDecodeError("Routine inbox receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: commandIdentifier(candidate.commandId, "Routine commandId"),
    status: "applied",
    inbox: decodeRoutineInboxViewV1(candidate.inbox),
  };
}

export function decodeRoutineRunDetailViewV1(
  value: unknown,
): RoutineRunDetailViewV1 {
  const candidate = record(value, "Routine run detail");
  routineExactKeys(
    candidate,
    [
      "schemaVersion",
      "botId",
      "routineId",
      "runId",
      "status",
      "admittedAt",
      "input",
      "events",
    ],
    ["outcome"],
    "Routine run detail",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine run detail schemaVersion is unsupported",
    );
  }
  if (!Array.isArray(candidate.events)) {
    throw new RoutineDecodeError("Routine run detail events must be an array");
  }
  if (candidate.events.length > ROUTINE_RUN_EVENT_MAX) {
    throw new RoutineDecodeError("Routine run detail is over its bound");
  }
  return {
    schemaVersion: 1,
    botId: commandIdentifier(candidate.botId, "Routine run detail botId"),
    routineId: commandIdentifier(
      candidate.routineId,
      "Routine run detail routineId",
    ),
    runId: routineText(candidate.runId, 256, "Routine run detail runId"),
    status: routineText(candidate.status, 64, "Routine run detail status"),
    admittedAt: routineTimestamp(
      candidate.admittedAt,
      "Routine run detail admittedAt",
    ),
    input: routineText(candidate.input, 16_000, "Routine run detail input"),
    events: candidate.events.map((event) => {
      const entry = record(event, "Routine run detail event");
      routineExactKeys(
        entry,
        ["type", "at", "summary"],
        [],
        "Routine run detail event",
      );
      return {
        type: routineText(entry.type, 64, "Routine run detail event type"),
        at: routineTimestamp(entry.at, "Routine run detail event at"),
        summary: routineText(
          entry.summary,
          2_000,
          "Routine run detail event summary",
        ),
      };
    }),
    ...(candidate.outcome === undefined
      ? {}
      : {
          outcome: routineText(
            candidate.outcome,
            4_000,
            "Routine run detail outcome",
          ),
        }),
  };
}
