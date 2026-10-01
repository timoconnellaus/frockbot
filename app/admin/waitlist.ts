// The beta waitlist and the "you're in" email an invitation sends.
//
// Both live in the deployment's access authority beside the invitations they
// lead to. A waitlist entry is low stakes — a duplicate changes nothing and a
// lost one costs a person a re-submit — so it is plain. The email is an
// external effect, so it is claimed before it is sent and never sent twice for
// one invitation.

import {
  decodeEmailInvitationV1,
  normalizeAccessEmailV1,
  type EmailInvitationV1,
} from "./shared.js";

/** Optional: what someone said they'd hand off first, as one short line. */
export const WAITLIST_FIRST_JOB_MAX_LENGTH_V1 = 200;
/** Past this many entries a join is answered but not kept. */
export const WAITLIST_CAPACITY_V1 = 20_000;
/** The most rows the admin portal is handed at once, oldest first. */
export const WAITLIST_VIEW_LIMIT_V1 = 500;
/** The largest batch one "invite the next" may take. */
export const WAITLIST_INVITE_BATCH_MAX_V1 = 100;

export interface WaitlistEntryV1 {
  schemaVersion: 1;
  email: string;
  joinedAt: string;
  firstJob?: string;
}

export interface JoinWaitlistRequestV1 {
  schemaVersion: 1;
  email: string;
  firstJob?: string;
}

export interface JoinWaitlistResultV1 {
  schemaVersion: 1;
  status: "joined" | "already-joined" | "full";
}

/**
 * Where an invitation's email got to. `sending` is claimed and not yet
 * answered; a send that never answers stays `sending`, which is read the same
 * as `unknown`: it may have gone, so it is never sent again.
 */
export type InvitationNoticeStatusV1 =
  "sending" | "sent" | "unavailable" | "unknown";

export interface InvitationNoticeV1 {
  schemaVersion: 1;
  email: string;
  status: InvitationNoticeStatusV1;
  updatedAt: string;
  detail?: string;
}

export interface WaitlistRowV1 {
  entry: WaitlistEntryV1;
  invitation?: EmailInvitationV1;
  notice?: InvitationNoticeV1;
}

export interface WaitlistViewV1 {
  schemaVersion: 1;
  /** Everyone waiting or invited, including those past the rows shown. */
  total: number;
  waiting: number;
  /** Oldest first, at most `WAITLIST_VIEW_LIMIT_V1`. */
  rows: WaitlistRowV1[];
}

export interface InviteWaitlistRequestV1 {
  schemaVersion: 1;
  count: number;
  invitedBy: string;
}

export interface InviteWaitlistResultV1 {
  schemaVersion: 1;
  invitations: EmailInvitationV1[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fields(
  input: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = object(input, label);
  const keys = Object.keys(value);
  const allowed = ["schemaVersion", ...required, ...optional];
  if (
    !["schemaVersion", ...required].every((key) => keys.includes(key)) ||
    !keys.every((key) => allowed.includes(key))
  ) {
    throw new Error(`${label} has unknown fields`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function count(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  if ((value as number) > maximum) throw new Error(`${label} is too large`);
  return value as number;
}

/**
 * What a person typed as their first job, as one plain line: control and
 * format characters out, whitespace collapsed, cut to length. Nothing left
 * means they said nothing.
 */
export function normalizeFirstJobV1(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length === 0) return undefined;
  return [...line].slice(0, WAITLIST_FIRST_JOB_MAX_LENGTH_V1).join("");
}

function firstJob(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeFirstJobV1(value);
  if (normalized === undefined || normalized !== value) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function decodeWaitlistEntryV1(input: unknown): WaitlistEntryV1 {
  const entry = fields(
    input,
    "waitlist entry",
    ["email", "joinedAt"],
    ["firstJob"],
  );
  const job = firstJob(entry.firstJob, "waitlist entry.firstJob");
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(entry.email, "waitlist entry.email"),
    joinedAt: timestamp(entry.joinedAt, "waitlist entry.joinedAt"),
    ...(job === undefined ? {} : { firstJob: job }),
  };
}

export function decodeJoinWaitlistRequestV1(
  input: unknown,
): JoinWaitlistRequestV1 {
  const request = fields(
    input,
    "waitlist join request",
    ["email"],
    ["firstJob"],
  );
  const job = firstJob(request.firstJob, "waitlist join request.firstJob");
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(request.email, "waitlist join request.email"),
    ...(job === undefined ? {} : { firstJob: job }),
  };
}

const JOIN_STATUSES: readonly JoinWaitlistResultV1["status"][] = [
  "joined",
  "already-joined",
  "full",
];

export function decodeJoinWaitlistResultV1(
  input: unknown,
): JoinWaitlistResultV1 {
  const result = fields(input, "waitlist join result", ["status"]);
  if (
    !JOIN_STATUSES.includes(result.status as JoinWaitlistResultV1["status"])
  ) {
    throw new Error("waitlist join result.status is invalid");
  }
  return {
    schemaVersion: 1,
    status: result.status as JoinWaitlistResultV1["status"],
  };
}

const NOTICE_STATUSES: readonly InvitationNoticeStatusV1[] = [
  "sending",
  "sent",
  "unavailable",
  "unknown",
];

export function decodeInvitationNoticeV1(input: unknown): InvitationNoticeV1 {
  const notice = fields(
    input,
    "invitation notice",
    ["email", "status", "updatedAt"],
    ["detail"],
  );
  if (!NOTICE_STATUSES.includes(notice.status as InvitationNoticeStatusV1)) {
    throw new Error("invitation notice.status is invalid");
  }
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(notice.email, "invitation notice.email"),
    status: notice.status as InvitationNoticeStatusV1,
    updatedAt: timestamp(notice.updatedAt, "invitation notice.updatedAt"),
    ...(notice.detail === undefined
      ? {}
      : { detail: text(notice.detail, "invitation notice.detail", 1000) }),
  };
}

/** The address an invitation's email is claimed or answered for. */
export function decodeInvitationNoticeRequestV1(input: unknown): {
  schemaVersion: 1;
  email: string;
} {
  const request = fields(input, "invitation notice request", ["email"]);
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(
      request.email,
      "invitation notice request.email",
    ),
  };
}

export interface RecordInvitationNoticeRequestV1 {
  schemaVersion: 1;
  email: string;
  status: Exclude<InvitationNoticeStatusV1, "sending">;
  detail?: string;
}

export function decodeRecordInvitationNoticeRequestV1(
  input: unknown,
): RecordInvitationNoticeRequestV1 {
  const request = fields(
    input,
    "invitation notice record",
    ["email", "status"],
    ["detail"],
  );
  if (
    request.status !== "sent" &&
    request.status !== "unavailable" &&
    request.status !== "unknown"
  ) {
    throw new Error("invitation notice record.status is invalid");
  }
  return {
    schemaVersion: 1,
    email: normalizeAccessEmailV1(
      request.email,
      "invitation notice record.email",
    ),
    status: request.status,
    ...(request.detail === undefined
      ? {}
      : {
          detail: text(request.detail, "invitation notice record.detail", 1000),
        }),
  };
}

export function decodeWaitlistViewV1(input: unknown): WaitlistViewV1 {
  const view = fields(input, "waitlist view", ["total", "waiting", "rows"]);
  if (!Array.isArray(view.rows) || view.rows.length > WAITLIST_VIEW_LIMIT_V1) {
    throw new Error("waitlist view.rows is invalid");
  }
  return {
    schemaVersion: 1,
    total: count(view.total, "waitlist view.total", WAITLIST_CAPACITY_V1),
    waiting: count(view.waiting, "waitlist view.waiting", WAITLIST_CAPACITY_V1),
    rows: view.rows.map((input, index) => {
      const row = object(input, `waitlist view.rows[${index}]`);
      const keys = Object.keys(row);
      if (
        !keys.includes("entry") ||
        !keys.every((key) => ["entry", "invitation", "notice"].includes(key))
      ) {
        throw new Error(`waitlist view.rows[${index}] has unknown fields`);
      }
      return {
        entry: decodeWaitlistEntryV1(row.entry),
        ...(row.invitation === undefined
          ? {}
          : { invitation: decodeEmailInvitationV1(row.invitation) }),
        ...(row.notice === undefined
          ? {}
          : { notice: decodeInvitationNoticeV1(row.notice) }),
      };
    }),
  };
}

export function decodeInviteWaitlistRequestV1(
  input: unknown,
): InviteWaitlistRequestV1 {
  const request = fields(input, "waitlist invite request", [
    "count",
    "invitedBy",
  ]);
  const batch = count(
    request.count,
    "waitlist invite request.count",
    WAITLIST_INVITE_BATCH_MAX_V1,
  );
  if (batch === 0) throw new Error("waitlist invite request.count is invalid");
  return {
    schemaVersion: 1,
    count: batch,
    invitedBy: text(
      request.invitedBy,
      "waitlist invite request.invitedBy",
      512,
    ),
  };
}

export function decodeInviteWaitlistResultV1(
  input: unknown,
): InviteWaitlistResultV1 {
  const result = fields(input, "waitlist invite result", ["invitations"]);
  if (
    !Array.isArray(result.invitations) ||
    result.invitations.length > WAITLIST_INVITE_BATCH_MAX_V1
  ) {
    throw new Error("waitlist invite result.invitations is invalid");
  }
  return {
    schemaVersion: 1,
    invitations: result.invitations.map((invitation) =>
      decodeEmailInvitationV1(invitation),
    ),
  };
}

/**
 * The "you're in" email. Plain text, and nothing in it comes from the
 * waitlist form: anyone can put any address on the list, so the message a
 * stranger's address receives says only what the deployment says.
 */
export function invitationNoticeMessageV1(input: {
  productName: string;
  origin: string;
  email: string;
}): { subject: string; body: string } {
  return {
    subject: `You're in: your ${input.productName} invite`,
    body: [
      "You're in.",
      "",
      `Thanks for waiting. Your ${input.productName} beta invite is ready.`,
      "",
      `Sign in with the account for ${input.email} and your first bot will be waiting:`,
      input.origin,
      "",
      "It's a beta, so some things will be rough. Your bots show what they did and what it cost, and work pauses rather than running up a bill.",
      "",
      `If you didn't ask to join the ${input.productName} beta, you can ignore this email.`,
    ].join("\n"),
  };
}
