/**
 * Approval cards (parity register row 53).
 *
 * The constitution's *Self-modification* rule is the whole reason this module
 * exists: "a request for more becomes a durable pending decision for the User,
 * never a grant". An `approval` send is that request, and `ApprovalRecordV1` is
 * that durable pending decision. Nothing here grants anything; the record only
 * ever says what the User answered, or that nobody did.
 *
 * Three rules live here and nowhere else.
 *
 *  * **Written where the Turn settles.** `approvalTerminalRecordsV1` is handed
 *    the settled run and a reader bound to the transaction settling it, and
 *    returns the records that transaction writes. So there is no window in
 *    which a card has been shown to a person and no decision could be recorded
 *    against it — the card and its record become durable at the same instant.
 *
 *  * **First write wins.** A decision is recorded once. A replayed `POST`
 *    answers with the decision already stored rather than overwriting it, which
 *    is "Recovery never silently duplicates" applied to a human answer: two
 *    clicks on Approve and Deny cannot both be true, and the first one is.
 *
 *  * **Never an unbounded wait.** Every record carries an `expiresAt`, clamped
 *    between five minutes and seven days with a day as the default. The Bot
 *    Durable Object's own alarm expires it, and expiry queues the same pending
 *    input a human decision does, so the Bot always learns the outcome.
 */
import type { SendToUserApprovalRiskV1 } from "@frockbot/kernel-contracts";

/** One `ApprovalRecordV1`, keyed by the Bot's own approval id. */
export const APPROVAL_PREFIX = "shell:approval:";

/** How long a card waits when the Bot names no window. */
export const APPROVAL_DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
/**
 * The shortest window. Below it a card would expire before a person who is not
 * already looking at the screen could answer it, which is a refusal dressed as
 * a question.
 */
export const APPROVAL_MIN_EXPIRY_SECONDS = 5 * 60;
/** The longest. Past a week a pending decision is not pending, it is forgotten. */
export const APPROVAL_MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Most records retained per Bot. Trimming loses a row, never a fact: the send
 * itself stays on the durable log of the Turn that made it.
 */
export const APPROVAL_RETENTION_LIMIT = 200;

const MAX_ID_LENGTH = 256;
const MAX_ACTION_LENGTH = 2_000;
const MAX_TIMESTAMP_LENGTH = 64;
const SEND_RATIONALE_MAX = 8_000;

export class ApprovalDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalDecodeError";
  }
}

/** What a pending decision resolved to, or that it has not. */
export type ApprovalDecisionV1 = "pending" | "approved" | "denied" | "expired";

/** The two answers a person may give. Expiry is not one of them. */
export type ApprovalUserDecisionV1 = "approved" | "denied";

/** The durable pending decision. One key, one schema version. */
export interface ApprovalRecordV1 {
  schemaVersion: 1;
  approvalId: string;
  /** The Turn that asked. */
  runId: string;
  sessionId: string;
  action: string;
  risk: SendToUserApprovalRiskV1;
  createdAt: string;
  expiresAt: string;
  decision: ApprovalDecisionV1;
  decidedAt?: string;
  /**
   * Who answered. `"user"` for a person, `"expiry"` for the alarm — recorded
   * rather than inferred, so a record read years later still says whether
   * anyone actually looked at it.
   */
  decidedBy: "user" | "expiry" | "pending";
  rationale?: string;
}

export function approvalKeyV1(approvalId: string): string {
  return `${APPROVAL_PREFIX}${approvalId}`;
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApprovalDecodeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ApprovalDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ApprovalDecodeError(`${label} is missing "${key}"`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApprovalDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new ApprovalDecodeError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const stamp = text(value, MAX_TIMESTAMP_LENGTH, label);
  if (Number.isNaN(Date.parse(stamp))) {
    throw new ApprovalDecodeError(`${label} is not a timestamp`);
  }
  return stamp;
}

function risk(value: unknown, label: string): SendToUserApprovalRiskV1 {
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new ApprovalDecodeError(`${label} must be low, medium or high`);
  }
  return value;
}

function decision(value: unknown, label: string): ApprovalDecisionV1 {
  if (
    value !== "pending" &&
    value !== "approved" &&
    value !== "denied" &&
    value !== "expired"
  ) {
    throw new ApprovalDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeApprovalRecordV1(
  value: unknown,
  label = "approval record",
): ApprovalRecordV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "approvalId",
      "runId",
      "sessionId",
      "action",
      "risk",
      "createdAt",
      "expiresAt",
      "decision",
      "decidedBy",
    ],
    ["decidedAt", "rationale"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    candidate.decidedBy !== "user" &&
    candidate.decidedBy !== "expiry" &&
    candidate.decidedBy !== "pending"
  ) {
    throw new ApprovalDecodeError(`${label} decidedBy is invalid`);
  }
  return {
    schemaVersion: 1,
    approvalId: text(
      candidate.approvalId,
      MAX_ID_LENGTH,
      `${label} approvalId`,
    ),
    runId: text(candidate.runId, MAX_ID_LENGTH, `${label} runId`),
    sessionId: text(candidate.sessionId, MAX_ID_LENGTH, `${label} sessionId`),
    action: text(candidate.action, MAX_ACTION_LENGTH, `${label} action`),
    risk: risk(candidate.risk, `${label} risk`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
    expiresAt: timestamp(candidate.expiresAt, `${label} expiresAt`),
    decision: decision(candidate.decision, `${label} decision`),
    decidedBy: candidate.decidedBy,
    ...(candidate.decidedAt === undefined
      ? {}
      : { decidedAt: timestamp(candidate.decidedAt, `${label} decidedAt`) }),
    ...(candidate.rationale === undefined
      ? {}
      : {
          rationale: text(
            candidate.rationale,
            SEND_RATIONALE_MAX,
            `${label} rationale`,
          ),
        }),
  };
}

/**
 * When a card expires, given when it was asked and what the Bot requested.
 *
 * The clamp is the contract, not a suggestion: a Bot that asks for one second
 * gets five minutes, one that asks for a year gets a week, and one that asks
 * for nothing gets a day. Nothing downstream re-checks it, so nothing
 * downstream can disagree about it.
 */
export function approvalExpiresAtV1(
  createdAt: string,
  expiresInSeconds?: number,
): string {
  const requested =
    expiresInSeconds === undefined || !Number.isFinite(expiresInSeconds)
      ? APPROVAL_DEFAULT_EXPIRY_SECONDS
      : Math.floor(expiresInSeconds);
  const seconds = Math.min(
    APPROVAL_MAX_EXPIRY_SECONDS,
    Math.max(APPROVAL_MIN_EXPIRY_SECONDS, requested),
  );
  const asked = Date.parse(createdAt);
  if (Number.isNaN(asked)) {
    throw new ApprovalDecodeError("approval createdAt is not a timestamp");
  }
  return new Date(asked + seconds * 1_000).toISOString();
}

/** One approval send that a settled Turn made, in the order it made them. */
export interface ApprovalSendV1 {
  approvalId: string;
  action: string;
  rationale?: string;
  risk: SendToUserApprovalRiskV1;
  expiresInSeconds?: number;
}

/**
 * The approval sends on a settled Turn's durable log. Read off `send/to-user`
 * events rather than off anything the Agent returned, because the log is the
 * reconstruction surface and a recovered Turn has only the log.
 */
export function approvalSendsV1(
  events: readonly { type: string }[],
): ApprovalSendV1[] {
  const sends: ApprovalSendV1[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "send/to-user") continue;
    const payload = (event as { payload?: { type?: string } }).payload;
    if (!payload || payload.type !== "approval") continue;
    const approval = payload as unknown as ApprovalSendV1;
    // The same card sent twice in one Turn is one decision, and the first
    // wording of it is the one the person was shown first.
    if (seen.has(approval.approvalId)) continue;
    seen.add(approval.approvalId);
    sends.push(approval);
  }
  return sends;
}

/** The settled Turn a terminal record set is computed from. */
export interface ApprovalTerminalInputV1 {
  run: {
    runId: string;
    sessionId: string;
    events: readonly { type: string }[];
  };
  now: string;
  read<T>(key: string): Promise<T | undefined>;
}

/**
 * The approval records one settled Turn contributes to the transaction that
 * settles it.
 *
 * A record that already exists is left exactly as it is. That is what makes a
 * recovered or replayed Turn safe: the Turn is re-settled, the same send is
 * read off the same log, and a decision a person made in between is not
 * overwritten by a second `pending`.
 */
export async function approvalTerminalRecordsV1(
  input: ApprovalTerminalInputV1,
): Promise<Record<string, unknown>> {
  const records: Record<string, unknown> = {};
  for (const send of approvalSendsV1(input.run.events)) {
    const key = approvalKeyV1(send.approvalId);
    if ((await input.read<unknown>(key)) !== undefined) continue;
    records[key] = {
      schemaVersion: 1,
      approvalId: send.approvalId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      action: send.action,
      risk: send.risk,
      createdAt: input.now,
      expiresAt: approvalExpiresAtV1(input.now, send.expiresInSeconds),
      decision: "pending",
      decidedBy: "pending",
      ...(send.rationale === undefined ? {} : { rationale: send.rationale }),
    } satisfies ApprovalRecordV1;
  }
  return records;
}

/** One approval, as the hosted client is told it. */
export interface ApprovalCardViewV1 {
  schemaVersion: 1;
  approvalId: string;
  runId: string;
  action: string;
  risk: SendToUserApprovalRiskV1;
  createdAt: string;
  expiresAt: string;
  decision: ApprovalDecisionV1;
  decidedAt?: string;
  rationale?: string;
}

export function projectApprovalCardV1(
  stored: ApprovalRecordV1,
): ApprovalCardViewV1 {
  return {
    schemaVersion: 1,
    approvalId: stored.approvalId,
    runId: stored.runId,
    action: stored.action,
    risk: stored.risk,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    decision: stored.decision,
    ...(stored.decidedAt === undefined ? {} : { decidedAt: stored.decidedAt }),
    ...(stored.rationale === undefined ? {} : { rationale: stored.rationale }),
  };
}

/**
 * The Bot's approvals, newest first, with the pending count beside them.
 *
 * Decided cards are carried too, because the card in the transcript has to be
 * able to say what was decided rather than going quiet the moment it is
 * answered; `pending` is the number the settings surface counts.
 */
export interface ApprovalListViewV1 {
  schemaVersion: 1;
  botId: string;
  approvals: ApprovalCardViewV1[];
  pending: number;
}

/** One decision, as a person submits it. */
export interface ApprovalDecisionCommandV1 {
  schemaVersion: 1;
  decision: ApprovalUserDecisionV1;
}

/** What the decision route answers, on the first call and on every replay. */
export interface ApprovalDecisionReceiptV1 {
  schemaVersion: 1;
  approval: ApprovalCardViewV1;
  /** `recorded` on the write that decided it; `replayed` on every one after. */
  status: "recorded" | "replayed";
}

export function decodeApprovalDecisionCommandV1(
  value: unknown,
  label = "approval decision",
): ApprovalDecisionCommandV1 {
  const candidate = record(value, label);
  exactKeys(candidate, ["schemaVersion", "decision"], [], label);
  if (candidate.schemaVersion !== 1) {
    throw new ApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.decision !== "approved" && candidate.decision !== "denied") {
    throw new ApprovalDecodeError(
      `${label} decision must be approved or denied`,
    );
  }
  return { schemaVersion: 1, decision: candidate.decision };
}

function decodeApprovalCardV1(
  value: unknown,
  label = "approval card",
): ApprovalCardViewV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "approvalId",
      "runId",
      "action",
      "risk",
      "createdAt",
      "expiresAt",
      "decision",
    ],
    ["decidedAt", "rationale"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  return {
    schemaVersion: 1,
    approvalId: text(
      candidate.approvalId,
      MAX_ID_LENGTH,
      `${label} approvalId`,
    ),
    runId: text(candidate.runId, MAX_ID_LENGTH, `${label} runId`),
    action: text(candidate.action, MAX_ACTION_LENGTH, `${label} action`),
    risk: risk(candidate.risk, `${label} risk`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
    expiresAt: timestamp(candidate.expiresAt, `${label} expiresAt`),
    decision: decision(candidate.decision, `${label} decision`),
    ...(candidate.decidedAt === undefined
      ? {}
      : { decidedAt: timestamp(candidate.decidedAt, `${label} decidedAt`) }),
    ...(candidate.rationale === undefined
      ? {}
      : {
          rationale: text(
            candidate.rationale,
            SEND_RATIONALE_MAX,
            `${label} rationale`,
          ),
        }),
  };
}

export function decodeApprovalListViewV1(
  value: unknown,
  label = "approval list",
): ApprovalListViewV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ["schemaVersion", "botId", "approvals", "pending"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new ApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!Array.isArray(candidate.approvals)) {
    throw new ApprovalDecodeError(`${label} approvals must be an array`);
  }
  if (
    typeof candidate.pending !== "number" ||
    !Number.isSafeInteger(candidate.pending) ||
    candidate.pending < 0
  ) {
    throw new ApprovalDecodeError(`${label} pending is invalid`);
  }
  return {
    schemaVersion: 1,
    botId: text(candidate.botId, MAX_ID_LENGTH, `${label} botId`),
    approvals: candidate.approvals.map((entry) =>
      decodeApprovalCardV1(entry, `${label} entry`),
    ),
    pending: candidate.pending,
  };
}

export function decodeApprovalDecisionReceiptV1(
  value: unknown,
  label = "approval receipt",
): ApprovalDecisionReceiptV1 {
  const candidate = record(value, label);
  exactKeys(candidate, ["schemaVersion", "approval", "status"], [], label);
  if (candidate.schemaVersion !== 1) {
    throw new ApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.status !== "recorded" && candidate.status !== "replayed") {
    throw new ApprovalDecodeError(`${label} status is invalid`);
  }
  return {
    schemaVersion: 1,
    approval: decodeApprovalCardV1(candidate.approval, `${label} approval`),
    status: candidate.status,
  };
}

/**
 * Who is told about a pending decision, and how loudly.
 *
 * An approval ignores `notifications.enabled` on purpose: muting a Bot silences
 * its chatter, not a question that has stopped it. The urgency says so —
 * `critical` is the one value the desktop and mobile notification Packages
 * treat as interrupting.
 */
export function approvalNotificationIdV1(approvalId: string): string {
  return `approval:${approvalId}`;
}

/** What the User is told a card says, bounded for a notification body. */
export function approvalNotificationBodyV1(send: ApprovalSendV1): string {
  return `${send.risk === "high" ? "High risk. " : ""}${send.action}`.slice(
    0,
    240,
  );
}

/** The decided approvals a listing may drop, oldest first. */
export function trimmableApprovalKeysV1(
  keys: readonly string[],
  limit = APPROVAL_RETENTION_LIMIT,
): string[] {
  const sorted = [...keys].sort();
  return sorted.length <= limit ? [] : sorted.slice(0, sorted.length - limit);
}
