// The Audit Package's narrow, versioned DTOs and their decoders.
//
// WHAT AUDIT IS. Parity register rows 30 and 30b: GrokBot writes one
// `audit.jsonl` line per shell command carrying turn id and target, and a
// separate `audit-outbox.json` covering shell, browser navigation and MCP
// calls. FrockBot answers with one surface over all five kinds.
//
// WHAT IT IS NOT. It is not authority, and it records nothing a Turn did not
// already record. `AGENTS.md` § Authorities: the Bot's Durable Object holds
// the append-only event log, and `tool/call` already carries
// `{turn, step, occurrenceId, name, input}` with `tool/result` carrying the
// outcome. An audit entry is a *projection* of those durable events — the
// constitution's "indexes … are always rebuildable" rule applied to a second
// durable write nobody needs. `rebuildAuditIndex` proves it: the table can be
// emptied and reconstructed byte for byte.
//
// Every value here crosses a runtime boundary — a Bot Durable Object to the
// User Durable Object, the User object to the gateway, the gateway to a
// browser — so each is decoded at its seam with exact keys.

/** Most entries one User's audit table holds before the oldest are evicted. */
export const AUDIT_MAX_ROWS_V1 = 20_000;
/** The hard age bound. An entry older than this leaves whatever the row count. */
export const AUDIT_MAX_AGE_MS_V1 = 180 * 24 * 60 * 60 * 1_000;
/** Longest preview one entry carries, after redaction. */
export const AUDIT_MAX_PREVIEW_LENGTH_V1 = 200;
/** Most entries the Bot Durable Object's outbox holds before the oldest drop. */
export const AUDIT_MAX_OUTBOX_V1 = 512;
/** Most entries one contribution or rebuild page carries. */
export const AUDIT_MAX_ENTRY_PAGE_V1 = 512;
/**
 * Longest accepted paging cursor.
 *
 * The cursor is the base64 of a row's sort key, so it grows with the ids in
 * it: an instant plus three ids of up to 128 characters is at most 548.
 */
export const AUDIT_MAX_CURSOR_LENGTH_V1 = 1024;
/** Longest cursor a Bot's own entry projection pages by. */
const AUDIT_MAX_ENTRY_PAGE_CURSOR_LENGTH_V1 = 512;
/** Most entries one query page returns. */
export const AUDIT_MAX_RESULTS_V1 = 100;

const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_TARGET_LENGTH = 160;
const MAX_TOOL_NAME_LENGTH = 128;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OCCURRENCE_PATTERN =
  /^tool:([1-9][0-9]{0,8}):([1-9][0-9]{0,8}):([0-9]{1,9})(?:\.[0-9]{1,9})?$/;
/** `device:<useId>`, the id the client minted when the use began. */
const DEVICE_OCCURRENCE_PATTERN = /^device:[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export class AuditDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditDecodeError";
  }
}

/**
 * What an audited effect was.
 *
 * `process` exists for the Computer Package's `computer_process_*` tools,
 * which are in flight (parity register row 29, background commands that
 * outlive the Turn). The kind is declared now so the table does not change
 * shape when they land.
 */
export type AuditKindV1 =
  | "shell"
  | "browser"
  | "mcp"
  | "file"
  | "process"
  | "device"
  | "email"
  | "supervision";

export const AUDIT_KINDS_V1: readonly AuditKindV1[] = [
  "shell",
  "browser",
  "mcp",
  "file",
  "process",
  "device",
  "email",
  "supervision",
];

/**
 * How the effect ended.
 *
 * `unknown` is load-bearing rather than a fallback: a `tool/call` with no
 * matching `tool/result` is an effect whose outcome the durable log does not
 * know, and saying so is the constitution's "Failures are observable through
 * durable state". It is never quietly recorded as an error.
 */
export type AuditOutcomeV1 =
  "ok" | "error" | "refused" | "interrupted" | "unknown";

export const AUDIT_OUTCOMES_V1: readonly AuditOutcomeV1[] = [
  "ok",
  "error",
  "refused",
  "interrupted",
  "unknown",
];

/** The Bot's own Computer — the default target for every Computer effect. */
export const AUDIT_TARGET_COMPUTER_V1 = "computer";
/**
 * The User's Workspace in object storage.
 *
 * Memory and Skills live here, not on the Computer, and they are written
 * while it is hibernated — a Bot with no Computer configured at all still
 * writes Memory. Rows for those writes said "This Computer", which named a
 * machine that had nothing to do with the effect and, in the case we saw, did
 * not exist.
 */
export const AUDIT_TARGET_WORKSPACE_V1 = "workspace";
/** A registered machine of the User's, `machine:<id>` (parity register §2.16). */
export const AUDIT_TARGET_MACHINE_PREFIX_V1 = "machine:";
/** A remote MCP server, `remote:<host>`. */
export const AUDIT_TARGET_REMOTE_PREFIX_V1 = "remote:";
/** Mail the Bot sent from its own address, through the deployment's sender. */
export const AUDIT_TARGET_EMAIL_V1 = "email";
/** The conversation itself: what Turn supervision kept out of it. */
export const AUDIT_TARGET_CONVERSATION_V1 = "conversation";
/**
 * The person's device a Plugin's page used an ability on, `device:<kind>` —
 * `web`, `android`, `ios`, `macos` and the like, until devices have ids of
 * their own (ADR 0035).
 */
export const AUDIT_TARGET_DEVICE_PREFIX_V1 = "device:";

/**
 * One audited effect. Idempotent on `(botId, runId, occurrenceId)`.
 *
 * `argumentDigest` rather than the arguments: the digest proves two runs
 * issued the same call without the table holding a command line, an MCP
 * payload, or anything else a credential could be sitting in. `preview` is the
 * bounded, redacted human-readable half; `AGENTS.md` § Computer and Workspace
 * forbids a credential reaching durable state, so the exec op's `env` and
 * every `credentialRef` are never projected at all.
 */
export interface AuditEntryV1 {
  schemaVersion: 1;
  botId: string;
  /** A `device` use happened in no run: its run id is its occurrence id. */
  runId: string;
  /** `tool:<turn>:<step>:<ordinal>`, or `device:<useId>` for a `device` use. */
  occurrenceId: string;
  /** 0, with step and ordinal, for a `device` use, which no Turn issued. */
  turn: number;
  step: number;
  ordinal: number;
  /**
   * The id the effect ran under. A Computer tool's is the id its host requests
   * and billing reservation carried — `computerOperationIdV1` of the Bot, the
   * run and the occurrence, because an occurrence id repeats across Sessions
   * and Bots — and anything else's is its occurrence id.
   */
  effectId: string;
  /** ISO-8601: the run's admission time, so a rebuild reproduces it exactly. */
  at: string;
  kind: AuditKindV1;
  /** `computer`, `machine:<id>`, or `remote:<host>`. */
  target: string;
  toolName: string;
  /** Lowercase hex sha-256 of the exact argument JSON. */
  argumentDigest: string;
  /** At most {@link AUDIT_MAX_PREVIEW_LENGTH_V1} characters, redacted. */
  preview: string;
  outcome: AuditOutcomeV1;
  exitCode?: number;
  durationMs?: number;
  bytesOut?: number;
}

/** A page of one Bot's projected entries, as a rebuild pulls them. */
export interface AuditEntryPageV1 {
  schemaVersion: 1;
  botId: string;
  entries: AuditEntryV1[];
  /** Absent when the Bot has no further runs to project. */
  nextCursor?: string;
}

export type AuditIndexStateV1 = "ready" | "rebuilding" | "truncated";

/** What one rebuild did, and what it could not explain. */
export interface AuditRebuildReceiptV1 {
  schemaVersion: 1;
  status: "rebuilt";
  entries: number;
  bots: number;
  indexState: AuditIndexStateV1;
  /**
   * Entries whose outcome the durable event log does not know — a `tool/call`
   * with no matching `tool/result`. Always real, because it is derived from
   * the same events the table is.
   */
  unknownOutcomes: number;
}

// ---------------------------------------------------------------------------
// Decoders.
// ---------------------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuditDecodeError(`${label} must be an object`);
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
    throw new AuditDecodeError(`${label}.${field} is not allowed`);
  }
}

function text(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length > maximum) {
    throw new AuditDecodeError(`${label}.${key} must be a bounded string`);
  }
  return field;
}

function identifier(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = text(value, key, MAX_ID_LENGTH, label);
  if (field.length === 0) {
    throw new AuditDecodeError(`${label}.${key} must not be empty`);
  }
  return field;
}

function integer(
  value: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
  label: string,
): number {
  const field = value[key];
  if (
    !Number.isSafeInteger(field) ||
    (field as number) < bounds.min ||
    (field as number) > bounds.max
  ) {
    throw new AuditDecodeError(`${label}.${key} must be a bounded integer`);
  }
  return field as number;
}

/**
 * The `{turn, step, ordinal}` one occurrence id names.
 *
 * The whole design rests on this being decodable: turn, step and ordinal are
 * already in the durable event as one string
 * (`core/contracts/types.ts`, `toolOccurrenceId`), so audit needs no new
 * coordinate and no new authority to place an effect in a conversation.
 *
 * A call declared inside a `batch` carries the batch's id and a dotted
 * position (`core/contracts/batch.ts`, `batchToolOccurrenceId`). It is placed
 * at the batch's own coordinates — that is where the model issued it — and
 * the rows stay distinct because an entry is keyed by its occurrence id.
 */
export function decodeAuditOccurrenceIdV1(value: unknown): {
  turn: number;
  step: number;
  ordinal: number;
} {
  if (typeof value !== "string") {
    throw new AuditDecodeError("audit occurrence id must be a string");
  }
  const match = OCCURRENCE_PATTERN.exec(value);
  if (!match) {
    throw new AuditDecodeError(`audit occurrence id "${value}" is invalid`);
  }
  return {
    turn: Number(match[1]),
    step: Number(match[2]),
    ordinal: Number(match[3]),
  };
}

/** Whether a string is one of the target shapes this schema allows. */
export function isAuditTargetV1(value: string): boolean {
  if (value === AUDIT_TARGET_COMPUTER_V1) return true;
  if (value === AUDIT_TARGET_WORKSPACE_V1) return true;
  if (value === AUDIT_TARGET_EMAIL_V1) return true;
  if (value === AUDIT_TARGET_CONVERSATION_V1) return true;
  if (value.length > MAX_TARGET_LENGTH) return false;
  if (value.startsWith(AUDIT_TARGET_MACHINE_PREFIX_V1)) {
    return /^machine:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  }
  if (value.startsWith(AUDIT_TARGET_REMOTE_PREFIX_V1)) {
    return /^remote:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  }
  if (value.startsWith(AUDIT_TARGET_DEVICE_PREFIX_V1)) {
    return /^device:[a-z][a-z0-9-]{0,31}$/.test(value);
  }
  return false;
}

function auditKind(value: unknown, label: string): AuditKindV1 {
  if (
    typeof value !== "string" ||
    !AUDIT_KINDS_V1.includes(value as AuditKindV1)
  ) {
    throw new AuditDecodeError(`${label}.kind is invalid`);
  }
  return value as AuditKindV1;
}

function auditOutcome(value: unknown, label: string): AuditOutcomeV1 {
  if (
    typeof value !== "string" ||
    !AUDIT_OUTCOMES_V1.includes(value as AuditOutcomeV1)
  ) {
    throw new AuditDecodeError(`${label}.outcome is invalid`);
  }
  return value as AuditOutcomeV1;
}

const ENTRY_KEYS = [
  "schemaVersion",
  "botId",
  "runId",
  "occurrenceId",
  "turn",
  "step",
  "ordinal",
  "effectId",
  "at",
  "kind",
  "target",
  "toolName",
  "argumentDigest",
  "preview",
  "outcome",
  "exitCode",
  "durationMs",
  "bytesOut",
] as const;

export function decodeAuditEntryV1(input: unknown): AuditEntryV1 {
  const entry = record(input, "audit entry");
  exactKeys(entry, ENTRY_KEYS, "audit entry");
  if (entry.schemaVersion !== 1) {
    throw new AuditDecodeError("audit entry.schemaVersion must be 1");
  }
  const occurrenceId = text(
    entry,
    "occurrenceId",
    MAX_ID_LENGTH,
    "audit entry",
  );
  const kind = auditKind(entry.kind, "audit entry");
  const device = kind === "device";
  // A device use was no Turn's: it has no coordinates to place it by, and
  // saying 0 rather than inventing a Turn keeps "View activity details" off it.
  if (device) {
    if (
      !DEVICE_OCCURRENCE_PATTERN.test(occurrenceId) ||
      entry.runId !== occurrenceId
    ) {
      throw new AuditDecodeError(
        "audit entry for a device use must be keyed by its use id",
      );
    }
  }
  const coordinates = device
    ? { turn: 0, step: 0, ordinal: 0 }
    : decodeAuditOccurrenceIdV1(occurrenceId);
  const at = text(entry, "at", MAX_TIMESTAMP_LENGTH, "audit entry");
  if (!Number.isFinite(Date.parse(at))) {
    throw new AuditDecodeError("audit entry.at must be a timestamp");
  }
  const target = text(entry, "target", MAX_TARGET_LENGTH, "audit entry");
  if (
    !isAuditTargetV1(target) ||
    device !== target.startsWith(AUDIT_TARGET_DEVICE_PREFIX_V1)
  ) {
    throw new AuditDecodeError(`audit entry.target "${target}" is invalid`);
  }
  const argumentDigest = text(entry, "argumentDigest", 64, "audit entry");
  if (!DIGEST_PATTERN.test(argumentDigest)) {
    throw new AuditDecodeError("audit entry.argumentDigest must be a sha-256");
  }
  // The coordinates are carried as well as encoded so a reader need not parse
  // the id, and checked against it so the two can never disagree.
  if (
    integer(entry, "turn", { min: device ? 0 : 1, max: 1e9 }, "audit entry") !==
      coordinates.turn ||
    integer(entry, "step", { min: device ? 0 : 1, max: 1e9 }, "audit entry") !==
      coordinates.step ||
    integer(entry, "ordinal", { min: 0, max: 1e9 }, "audit entry") !==
      coordinates.ordinal
  ) {
    throw new AuditDecodeError(
      "audit entry coordinates disagree with its occurrence id",
    );
  }
  return {
    schemaVersion: 1,
    botId: identifier(entry, "botId", "audit entry"),
    runId: identifier(entry, "runId", "audit entry"),
    occurrenceId,
    turn: coordinates.turn,
    step: coordinates.step,
    ordinal: coordinates.ordinal,
    effectId: identifier(entry, "effectId", "audit entry"),
    at,
    kind,
    target,
    toolName: text(entry, "toolName", MAX_TOOL_NAME_LENGTH, "audit entry"),
    argumentDigest,
    preview: text(entry, "preview", AUDIT_MAX_PREVIEW_LENGTH_V1, "audit entry"),
    outcome: auditOutcome(entry.outcome, "audit entry"),
    ...(entry.exitCode === undefined
      ? {}
      : {
          exitCode: integer(
            entry,
            "exitCode",
            { min: -1_024, max: 1_024 },
            "audit entry",
          ),
        }),
    ...(entry.durationMs === undefined
      ? {}
      : {
          durationMs: integer(
            entry,
            "durationMs",
            { min: 0, max: 2 ** 40 },
            "audit entry",
          ),
        }),
    ...(entry.bytesOut === undefined
      ? {}
      : {
          bytesOut: integer(
            entry,
            "bytesOut",
            { min: 0, max: 2 ** 40 },
            "audit entry",
          ),
        }),
  };
}

export function decodeAuditEntryPageV1(input: unknown): AuditEntryPageV1 {
  const page = record(input, "audit entry page");
  exactKeys(
    page,
    ["schemaVersion", "botId", "entries", "nextCursor"],
    "audit entry page",
  );
  if (page.schemaVersion !== 1) {
    throw new AuditDecodeError("audit entry page.schemaVersion must be 1");
  }
  if (!Array.isArray(page.entries)) {
    throw new AuditDecodeError("audit entry page.entries must be an array");
  }
  if (page.entries.length > AUDIT_MAX_ENTRY_PAGE_V1) {
    throw new AuditDecodeError("audit entry page.entries exceeds its bound");
  }
  const botId = identifier(page, "botId", "audit entry page");
  const entries = page.entries.map(decodeAuditEntryV1);
  if (entries.some((entry) => entry.botId !== botId)) {
    throw new AuditDecodeError("audit entry page.entries names another Bot");
  }
  return {
    schemaVersion: 1,
    botId,
    entries,
    ...(page.nextCursor === undefined
      ? {}
      : {
          nextCursor: text(
            page,
            "nextCursor",
            AUDIT_MAX_ENTRY_PAGE_CURSOR_LENGTH_V1,
            "audit entry page",
          ),
        }),
  };
}

// ---------------------------------------------------------------------------
// The query, and what the client is answered with.
// ---------------------------------------------------------------------------

/** One filtered, paged request for a User's audit entries. */
export interface AuditQueryV1 {
  schemaVersion: 1;
  botId?: string;
  kind?: AuditKindV1;
  target?: string;
  /** Opaque page cursor from a previous answer's `page.nextCursor`. */
  before?: string;
  limit?: number;
}

export interface ClientAuditPageV1 {
  schemaVersion: 1;
  entries: AuditEntryV1[];
  /** The same page shape the transcript index answers with. */
  page: { truncated: boolean; nextCursor?: string };
  /** How many entries match the filters, before paging. */
  total: number;
  indexState: AuditIndexStateV1;
}

export function decodeAuditQueryV1(input: unknown): AuditQueryV1 {
  const query = record(input, "audit query");
  exactKeys(
    query,
    ["schemaVersion", "botId", "kind", "target", "before", "limit"],
    "audit query",
  );
  if (query.schemaVersion !== 1) {
    throw new AuditDecodeError("audit query.schemaVersion must be 1");
  }
  if (query.kind !== undefined) auditKind(query.kind, "audit query");
  if (query.target !== undefined) {
    const target = text(query, "target", MAX_TARGET_LENGTH, "audit query");
    if (!isAuditTargetV1(target)) {
      throw new AuditDecodeError("audit query.target is invalid");
    }
  }
  if (
    query.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) ||
      (query.limit as number) < 1 ||
      (query.limit as number) > AUDIT_MAX_RESULTS_V1)
  ) {
    throw new AuditDecodeError("audit query.limit must be a bounded integer");
  }
  return {
    schemaVersion: 1,
    ...(query.botId === undefined
      ? {}
      : { botId: identifier(query, "botId", "audit query") }),
    ...(query.kind === undefined ? {} : { kind: query.kind as AuditKindV1 }),
    ...(query.target === undefined ? {} : { target: query.target as string }),
    ...(query.before === undefined
      ? {}
      : {
          before: text(
            query,
            "before",
            AUDIT_MAX_CURSOR_LENGTH_V1,
            "audit query",
          ),
        }),
    ...(query.limit === undefined ? {} : { limit: query.limit as number }),
  };
}

export function decodeClientAuditPageV1(input: unknown): ClientAuditPageV1 {
  const answer = record(input, "audit page");
  exactKeys(
    answer,
    ["schemaVersion", "entries", "page", "total", "indexState"],
    "audit page",
  );
  if (answer.schemaVersion !== 1) {
    throw new AuditDecodeError("audit page.schemaVersion must be 1");
  }
  if (!Array.isArray(answer.entries)) {
    throw new AuditDecodeError("audit page.entries must be an array");
  }
  if (answer.entries.length > AUDIT_MAX_RESULTS_V1) {
    throw new AuditDecodeError("audit page.entries exceeds its bound");
  }
  const page = record(answer.page, "audit page.page");
  exactKeys(page, ["truncated", "nextCursor"], "audit page.page");
  if (typeof page.truncated !== "boolean") {
    throw new AuditDecodeError("audit page.page.truncated must be a boolean");
  }
  if (
    !Number.isSafeInteger(answer.total) ||
    (answer.total as number) < answer.entries.length
  ) {
    throw new AuditDecodeError("audit page.total is invalid");
  }
  if (
    answer.indexState !== "ready" &&
    answer.indexState !== "rebuilding" &&
    answer.indexState !== "truncated"
  ) {
    throw new AuditDecodeError("audit page.indexState is invalid");
  }
  return {
    schemaVersion: 1,
    entries: answer.entries.map(decodeAuditEntryV1),
    page: {
      truncated: page.truncated,
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextCursor: text(
              page,
              "nextCursor",
              AUDIT_MAX_CURSOR_LENGTH_V1,
              "audit page.page",
            ),
          }),
    },
    total: answer.total as number,
    indexState: answer.indexState,
  };
}

export function decodeAuditRebuildReceiptV1(
  input: unknown,
): AuditRebuildReceiptV1 {
  const receipt = record(input, "audit rebuild receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "status",
      "entries",
      "bots",
      "indexState",
      "unknownOutcomes",
    ],
    "audit rebuild receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.status !== "rebuilt") {
    throw new AuditDecodeError("audit rebuild receipt is invalid");
  }
  for (const key of ["entries", "bots", "unknownOutcomes"] as const) {
    if (!Number.isSafeInteger(receipt[key]) || (receipt[key] as number) < 0) {
      throw new AuditDecodeError(
        `audit rebuild receipt.${key} must be a non-negative integer`,
      );
    }
  }
  if (
    receipt.indexState !== "ready" &&
    receipt.indexState !== "rebuilding" &&
    receipt.indexState !== "truncated"
  ) {
    throw new AuditDecodeError("audit rebuild receipt.indexState is invalid");
  }
  return {
    schemaVersion: 1,
    status: "rebuilt",
    entries: receipt.entries as number,
    bots: receipt.bots as number,
    indexState: receipt.indexState,
    unknownOutcomes: receipt.unknownOutcomes as number,
  };
}

// ---------------------------------------------------------------------------
// Activity: the same table, read a Turn at a time.
// ---------------------------------------------------------------------------

/**
 * The filters the Activity page offers, each a union of kinds.
 *
 * The table records what an effect was, never whether it only read, so no
 * filter is a judgement about the effect: a lookup in a connected service is
 * under "Sent & changed" with the rest of that service's calls, drawn quietly
 * rather than left out. Turn supervision's rows are under Everything alone.
 */
export const AUDIT_ACTIVITY_FILTERS_V1 = {
  everything: AUDIT_KINDS_V1,
  sent: ["email", "mcp", "file"],
  commands: ["shell", "process", "browser"],
  devices: ["device"],
} as const satisfies Record<string, readonly AuditKindV1[]>;

export type AuditActivityFilterV1 = keyof typeof AUDIT_ACTIVITY_FILTERS_V1;

export const AUDIT_ACTIVITY_FILTER_NAMES_V1 = Object.keys(
  AUDIT_ACTIVITY_FILTERS_V1,
) as AuditActivityFilterV1[];

/** Most rows one Activity page carries. */
export const AUDIT_ACTIVITY_MAX_ROWS_V1 = 100;

/** One filtered, paged request for a User's Activity. */
export interface AuditActivityQueryV1 {
  botId?: string;
  filter?: AuditActivityFilterV1;
  /** Opaque cursor from a previous Activity page. */
  before?: string;
  limit?: number;
}

/**
 * Every entry one Turn made of one kind in one place, as one row.
 *
 * A Turn that ran six commands is one thing a person did not see, not six; a
 * Turn that ran commands and sent an email is two, because they happened in
 * two places.
 */
export interface AuditActivityGroupV1 {
  botId: string;
  runId: string;
  kind: AuditKindV1;
  target: string;
  count: number;
  /** The newest entry's time. */
  at: string;
  /** One entry's preview; the row's own only when `count` is 1. */
  preview: string;
  /** The distinct tools the entries ran. */
  toolNames: string[];
  failed: number;
  refused: number;
  interrupted: number;
  unknown: number;
  /** Entries an Approval authorized that went through. */
  approved: number;
  /** Summed where the entries carry one: how long a device was in use. */
  durationMs?: number;
}

export interface AuditActivityPageV1 {
  schemaVersion: 1;
  groups: AuditActivityGroupV1[];
  nextCursor?: string;
  indexState: AuditIndexStateV1;
}

const ACTIVITY_GROUP_KEYS = [
  "botId",
  "runId",
  "kind",
  "target",
  "count",
  "at",
  "preview",
  "toolNames",
  "failed",
  "refused",
  "interrupted",
  "unknown",
  "approved",
  "durationMs",
] as const;

function decodeAuditActivityGroupV1(input: unknown): AuditActivityGroupV1 {
  const label = "activity group";
  const group = record(input, label);
  exactKeys(group, ACTIVITY_GROUP_KEYS, label);
  const target = text(group, "target", MAX_TARGET_LENGTH, label);
  if (!isAuditTargetV1(target)) {
    throw new AuditDecodeError(`${label}.target is invalid`);
  }
  const at = text(group, "at", MAX_TIMESTAMP_LENGTH, label);
  if (!Number.isFinite(Date.parse(at))) {
    throw new AuditDecodeError(`${label}.at must be a timestamp`);
  }
  const toolNames = group.toolNames;
  if (
    !Array.isArray(toolNames) ||
    toolNames.length > 64 ||
    toolNames.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > MAX_TOOL_NAME_LENGTH,
    )
  ) {
    throw new AuditDecodeError(`${label}.toolNames is invalid`);
  }
  const tally = (key: string, min = 0) =>
    integer(group, key, { min, max: AUDIT_MAX_ROWS_V1 }, label);
  return {
    botId: identifier(group, "botId", label),
    runId: identifier(group, "runId", label),
    kind: auditKind(group.kind, label),
    target,
    count: tally("count", 1),
    at,
    preview: text(group, "preview", AUDIT_MAX_PREVIEW_LENGTH_V1, label),
    toolNames: toolNames as string[],
    failed: tally("failed"),
    refused: tally("refused"),
    interrupted: tally("interrupted"),
    unknown: tally("unknown"),
    approved: tally("approved"),
    ...(group.durationMs === undefined
      ? {}
      : {
          durationMs: integer(
            group,
            "durationMs",
            { min: 0, max: 2 ** 40 },
            label,
          ),
        }),
  };
}

export function decodeAuditActivityPageV1(input: unknown): AuditActivityPageV1 {
  const answer = record(input, "activity page");
  exactKeys(
    answer,
    ["schemaVersion", "groups", "nextCursor", "indexState"],
    "activity page",
  );
  if (answer.schemaVersion !== 1) {
    throw new AuditDecodeError("activity page.schemaVersion must be 1");
  }
  if (
    !Array.isArray(answer.groups) ||
    answer.groups.length > AUDIT_ACTIVITY_MAX_ROWS_V1
  ) {
    throw new AuditDecodeError("activity page.groups must be a bounded array");
  }
  if (
    answer.indexState !== "ready" &&
    answer.indexState !== "rebuilding" &&
    answer.indexState !== "truncated"
  ) {
    throw new AuditDecodeError("activity page.indexState is invalid");
  }
  return {
    schemaVersion: 1,
    groups: answer.groups.map(decodeAuditActivityGroupV1),
    ...(answer.nextCursor === undefined
      ? {}
      : {
          nextCursor: text(
            answer,
            "nextCursor",
            AUDIT_MAX_CURSOR_LENGTH_V1,
            "activity page",
          ),
        }),
    indexState: answer.indexState,
  };
}
