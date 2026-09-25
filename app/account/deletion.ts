// Deleting an account, as one durable saga.
//
// The person confirms once and everything they own goes, at once — there is
// no grace period. What they own is spread across this deployment's objects,
// its buckets and index, the sign-in store and three providers, and no
// transaction reaches all of it. So the deletion is a record naming the step
// it is on, and the User Durable Object's alarm drives it forward until
// nothing is left of the account but a tombstone saying it was deleted.
//
// Every step is idempotent: it deletes what is still there and finds the rest
// already gone, so a crash anywhere repeats the step it was on and nothing
// else. No step is ever retried into a *new* effect — each one only removes.
// The order is the design:
//
// - Access ends first, so no request of the account's starts anything new
//   while its data is being destroyed.
// - The voice session and Group Chats go before the Bots, because both admit
//   work into Bots.
// - Every Bot goes through the Bot delete saga, which already purges its
//   vectors, its files and its object.
// - The Computer goes once no Bot is left that could open it again.
// - Provider accounts, the grants MCP servers issued, the payment customer,
//   files and vectors follow, while this object still holds what names them.
//   A grant is revoked at its server with the refresh token only this object
//   holds, so it has to go before the wipe does.
// - The sign-in identity goes before the access record, so no live session
//   is left that admission could let back in.
// - The object's own storage goes last, because it holds this record.

/** `GET` answers what to type to confirm; `POST` with it deletes the account. */
export const ACCOUNT_DELETION_PATH_V1 = "/api/account/delete";
/** `POST` deletes the Computer and nothing else. */
export const COMPUTER_DELETION_PATH_V1 = "/api/computer/delete";

/**
 * What the person types to confirm: the email they sign in with, or the
 * account's id when sign-in gave none (a development identity). Retyping it
 * is the whole confirmation — there is no grace period to undo it in.
 */
export function accountDeletionConfirmationV1(identity: {
  userId: string;
  email?: string;
}): string {
  return identity.email?.trim() || identity.userId;
}

/** Compared as an email is: trimmed, and without regard to case. */
export function accountDeletionConfirmedV1(
  expected: string,
  typed: string,
): boolean {
  return typed.trim().toLowerCase() === expected.trim().toLowerCase();
}

export interface AccountDeletionCommandV1 {
  schemaVersion: 1;
  commandId: string;
  confirmation: string;
}

export interface ComputerDeletionCommandV1 {
  schemaVersion: 1;
  commandId: string;
}

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;

function commandBody(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error(`${label} must be an object`);
  const value = input as Record<string, unknown>;
  const present = Object.keys(value);
  if (
    present.length !== keys.length ||
    present.some((key) => !keys.includes(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.commandId !== "string" ||
    !COMMAND_ID.test(value.commandId)
  )
    throw new Error(`${label} is invalid`);
  return value;
}

export function decodeAccountDeletionCommandV1(
  input: unknown,
): AccountDeletionCommandV1 {
  const value = commandBody(
    input,
    ["schemaVersion", "commandId", "confirmation"],
    "account deletion",
  );
  if (!boundedText(value.confirmation, 320))
    throw new Error("account deletion is invalid");
  return {
    schemaVersion: 1,
    commandId: value.commandId as string,
    confirmation: value.confirmation,
  };
}

export function decodeComputerDeletionCommandV1(
  input: unknown,
): ComputerDeletionCommandV1 {
  const value = commandBody(
    input,
    ["schemaVersion", "commandId"],
    "Computer deletion",
  );
  return { schemaVersion: 1, commandId: value.commandId as string };
}

/** Every step, in the order they run. */
export const ACCOUNT_DELETION_STEPS_V1 = [
  "access",
  "voice",
  "groups",
  "bots",
  "computer",
  "connected-apps",
  "mcp-servers",
  "payments",
  "files",
  "memory-vectors",
  "identity",
  "admission",
] as const;

export type AccountDeletionStepV1 = (typeof ACCOUNT_DELETION_STEPS_V1)[number];

/** Present while a deletion is under way. */
export const ACCOUNT_DELETION_KEY_V1 = "account:deletion:v1";
/**
 * Written after the object's storage is wiped, and kept for good. User ids
 * are never reused, so one key per deleted account is the whole cost of
 * refusing to provision a deleted User again.
 */
export const ACCOUNT_DELETED_KEY_V1 = "account:deleted:v1";

/** What a deleted, or deleting, account answers to anything asking it to act. */
export class AccountDeletedError extends Error {
  constructor() {
    super("This account has been deleted.");
    this.name = "AccountDeletedError";
  }
}

export interface AccountDeletionRecordV1 {
  schemaVersion: 1;
  userId: string;
  /** The command that started it; a later command joins this deletion. */
  commandId: string;
  requestedAt: string;
  /**
   * The address an invitation would be kept under, for the last step. It is
   * the one piece of personal data this record holds, and it goes when the
   * record does.
   */
  email?: string;
  step: AccountDeletionStepV1;
  /** Where a paged step picks up. */
  cursor?: string;
  /** Consecutive failures of the current step, for the retry delay. */
  attempts: number;
  lastFailure?: string;
}

export interface AccountDeletionTombstoneV1 {
  schemaVersion: 1;
  userId: string;
  requestedAt: string;
  deletedAt: string;
}

/** A step either finished, or made progress and must run again. */
export type AccountDeletionStepOutcomeV1 =
  { status: "complete" } | { status: "pending"; cursor?: string };

export interface AccountDeletionStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface AccountDeletionHostV1 {
  storage: AccountDeletionStorageV1;
  /** Runs one step once. Throwing is a failure the saga retries. */
  run(
    step: AccountDeletionStepV1,
    record: AccountDeletionRecordV1,
  ): Promise<AccountDeletionStepOutcomeV1>;
  /**
   * Wipes the object and writes the tombstone. The record this saga runs from
   * goes with the wipe, so this is the one call nothing follows.
   */
  erase(tombstone: AccountDeletionTombstoneV1): Promise<void>;
  now?: () => Date;
}

export type AccountDeletionProgressV1 =
  | { status: "idle" }
  | { status: "erased" }
  | { status: "pending"; step: AccountDeletionStepV1 }
  | { status: "failed"; step: AccountDeletionStepV1; attempts: number };

const FAILURE_LIMIT = 500;
/** Steps run per call; a fresh account's whole deletion fits in one. */
const STEP_BUDGET = ACCOUNT_DELETION_STEPS_V1.length + 1;

function isStep(value: unknown): value is AccountDeletionStepV1 {
  return ACCOUNT_DELETION_STEPS_V1.includes(value as AccountDeletionStepV1);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

export function decodeAccountDeletionRecordV1(
  input: unknown,
): AccountDeletionRecordV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("account deletion record must be an object");
  const value = input as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "userId",
    "commandId",
    "requestedAt",
    "email",
    "step",
    "cursor",
    "attempts",
    "lastFailure",
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    value.schemaVersion !== 1 ||
    !boundedText(value.userId, 200) ||
    !boundedText(value.commandId, 200) ||
    !boundedText(value.requestedAt, 64) ||
    (value.email !== undefined && !boundedText(value.email, 320)) ||
    !isStep(value.step) ||
    (value.cursor !== undefined && !boundedText(value.cursor, 4_096)) ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    (value.lastFailure !== undefined &&
      !boundedText(value.lastFailure, FAILURE_LIMIT))
  )
    throw new Error("account deletion record is invalid");
  return structuredClone(value) as unknown as AccountDeletionRecordV1;
}

export async function readAccountDeletionV1(
  storage: AccountDeletionStorageV1,
): Promise<AccountDeletionRecordV1 | undefined> {
  const stored = await storage.get<unknown>(ACCOUNT_DELETION_KEY_V1);
  return stored === undefined
    ? undefined
    : decodeAccountDeletionRecordV1(stored);
}

/**
 * Records that the account is being deleted, once. A second request — a
 * retried confirmation, another device — joins the deletion already under
 * way rather than starting another, and the answer says which.
 */
export async function beginAccountDeletionV1(
  storage: AccountDeletionStorageV1,
  request: { userId: string; commandId: string; email?: string },
  now: Date = new Date(),
): Promise<{ record: AccountDeletionRecordV1; begun: boolean }> {
  const existing = await readAccountDeletionV1(storage);
  if (existing) {
    if (existing.userId !== request.userId)
      throw new Error("account deletion names another User");
    return { record: existing, begun: false };
  }
  const record: AccountDeletionRecordV1 = {
    schemaVersion: 1,
    userId: request.userId,
    commandId: request.commandId,
    requestedAt: now.toISOString(),
    ...(request.email === undefined ? {} : { email: request.email }),
    step: ACCOUNT_DELETION_STEPS_V1[0],
    attempts: 0,
  };
  decodeAccountDeletionRecordV1(record);
  await storage.put(ACCOUNT_DELETION_KEY_V1, record);
  return { record, begun: true };
}

/**
 * Runs the saga forward from where its record says, as far as it will go:
 * until a step asks to be run again, a step fails, or the account is erased.
 *
 * The record is written after every step, so what one call finished is never
 * repeated by the next; a failure is recorded on the step it happened in and
 * leaves the cursor where it was.
 */
export async function advanceAccountDeletionV1(
  host: AccountDeletionHostV1,
): Promise<AccountDeletionProgressV1> {
  const now = host.now ?? (() => new Date());
  for (let budget = STEP_BUDGET; budget > 0; budget -= 1) {
    const record = await readAccountDeletionV1(host.storage);
    if (!record) return { status: "idle" };
    let outcome: AccountDeletionStepOutcomeV1;
    try {
      outcome = await host.run(record.step, record);
    } catch (error) {
      const attempts = record.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await host.storage.put(ACCOUNT_DELETION_KEY_V1, {
        ...record,
        attempts,
        lastFailure: (message || "failed").slice(0, FAILURE_LIMIT),
      } satisfies AccountDeletionRecordV1);
      return { status: "failed", step: record.step, attempts };
    }
    const { cursor: _cursor, lastFailure: _failure, ...rest } = record;
    if (outcome.status === "pending") {
      await host.storage.put(ACCOUNT_DELETION_KEY_V1, {
        ...rest,
        attempts: 0,
        ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
      } satisfies AccountDeletionRecordV1);
      return { status: "pending", step: record.step };
    }
    const next =
      ACCOUNT_DELETION_STEPS_V1[
        ACCOUNT_DELETION_STEPS_V1.indexOf(record.step) + 1
      ];
    if (next === undefined) {
      await host.erase({
        schemaVersion: 1,
        userId: record.userId,
        requestedAt: record.requestedAt,
        deletedAt: now().toISOString(),
      });
      return { status: "erased" };
    }
    await host.storage.put(ACCOUNT_DELETION_KEY_V1, {
      ...rest,
      step: next,
      attempts: 0,
    } satisfies AccountDeletionRecordV1);
  }
  const record = await readAccountDeletionV1(host.storage);
  return record ? { status: "pending", step: record.step } : { status: "idle" };
}

/**
 * How long the alarm waits before the next pass. A step that is waiting on
 * something — a Bot's paged purge, a provider's listing — is asked again in a
 * second; a failing one backs off to five minutes and never gives up, because
 * a deletion that stopped would keep what the person asked to have deleted.
 */
export function accountDeletionRetryDelayMsV1(
  progress: AccountDeletionProgressV1,
): number | undefined {
  if (progress.status === "pending") return 1_000;
  if (progress.status === "failed")
    return Math.min(300_000, 1_000 * 2 ** Math.min(progress.attempts, 9));
  return undefined;
}
