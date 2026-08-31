// The Audit Package's narrow, versioned DTOs and their decoders.
//
// WHAT AUDIT IS. Parity register rows 30 and 30b: GrokBot writes one
// `audit.jsonl` line per shell command carrying turn id and target, and a
// separate `audit-outbox.json` covering shell, browser navigation and MCP
// calls (`docs/research/grokbot-computer.md:189-195`, `:546-547`). FrockBot
// answers with one surface over all five kinds.
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
/** Longest accepted paging cursor. */
export const AUDIT_MAX_CURSOR_LENGTH_V1 = 64;
/** Most entries one query page returns. */
export const AUDIT_MAX_RESULTS_V1 = 100;

const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_TARGET_LENGTH = 160;
const MAX_TOOL_NAME_LENGTH = 128;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OCCURRENCE_PATTERN =
  /^tool:([1-9][0-9]{0,8}):([1-9][0-9]{0,8}):([0-9]{1,9})$/;

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
export type AuditKindV1 = "shell" | "browser" | "mcp" | "file" | "process";

export const AUDIT_KINDS_V1: readonly AuditKindV1[] = [
  "shell",
  "browser",
  "mcp",
  "file",
  "process",
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
/** A registered machine of the User's, `machine:<id>` (parity register §2.16). */
export const AUDIT_TARGET_MACHINE_PREFIX_V1 = "machine:";
/** A remote MCP server, `remote:<host>`. */
export const AUDIT_TARGET_REMOTE_PREFIX_V1 = "remote:";

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
  runId: string;
  /** `tool:<turn>:<step>:<ordinal>`; also the Computer envelope's `effectId`. */
  occurrenceId: string;
  turn: number;
  step: number;
  ordinal: number;
  /**
   * The durable effect identifier. `plugin-shell` writes
   * `occurrenceId: context.effectId`, so this is the same string the Computer
   * host's envelope carries and the key a host-journal reconciliation joins on.
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
   * Effects the Computer host's own journal reported that no durable session
   * event accounts for. The host is non-authoritative (`AGENTS.md`
   * § Computer and Workspace), so such an effect is *counted and named*, never
   * written into the table as if a Turn had recorded it.
   */
  hostJournalDiscrepancies: number;
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
 * (`kernel-contracts/src/types.ts`, `toolOccurrenceId`), so audit needs no new
 * coordinate and no new authority to place an effect in a conversation.
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

/** Whether a string is one of the three target shapes this schema allows. */
export function isAuditTargetV1(value: string): boolean {
  if (value === AUDIT_TARGET_COMPUTER_V1) return true;
  if (value.length > MAX_TARGET_LENGTH) return false;
  if (value.startsWith(AUDIT_TARGET_MACHINE_PREFIX_V1)) {
    return /^machine:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  }
  if (value.startsWith(AUDIT_TARGET_REMOTE_PREFIX_V1)) {
    return /^remote:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
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
  const coordinates = decodeAuditOccurrenceIdV1(occurrenceId);
  const at = text(entry, "at", MAX_TIMESTAMP_LENGTH, "audit entry");
  if (!Number.isFinite(Date.parse(at))) {
    throw new AuditDecodeError("audit entry.at must be a timestamp");
  }
  const target = text(entry, "target", MAX_TARGET_LENGTH, "audit entry");
  if (!isAuditTargetV1(target)) {
    throw new AuditDecodeError(`audit entry.target "${target}" is invalid`);
  }
  const argumentDigest = text(entry, "argumentDigest", 64, "audit entry");
  if (!DIGEST_PATTERN.test(argumentDigest)) {
    throw new AuditDecodeError("audit entry.argumentDigest must be a sha-256");
  }
  // The coordinates are carried as well as encoded so a reader need not parse
  // the id, and checked against it so the two can never disagree.
  if (
    integer(entry, "turn", { min: 1, max: 1e9 }, "audit entry") !==
      coordinates.turn ||
    integer(entry, "step", { min: 1, max: 1e9 }, "audit entry") !==
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
    kind: auditKind(entry.kind, "audit entry"),
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
            AUDIT_MAX_CURSOR_LENGTH_V1 * 8,
            "audit entry page",
          ),
        }),
  };
}
