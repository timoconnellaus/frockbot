// The Bot Durable Object's half of a machine command: intent, recorded before
// anything runs.
//
// A machine tool does not run a command. It writes one of these, asks the User
// for an approval, and ends the Turn. The command reaches the User's laptop
// only when a person answers, and it is *this* record the settlement reads to
// know what they answered about — the pending-input preamble carries only an
// `approvalId` and a decision, so the action it authorizes has to be
// recoverable from that id alone.
//
// Three properties the rest of the slice rests on:
//
//  1. **`approvalId === commandId === effectId`.** One identity for the
//     decision, the queue key and the Turn's durable occurrence, so a replayed
//     settlement addresses the same command rather than queueing a second one.
//  2. **Written before the send.** "Record intent before an external effect."
//     The record is durable before the card the User sees exists, so there is
//     no window in which somebody could approve an action nothing describes.
//  3. **Pure.** Everything here is a function of its arguments. The storage
//     seam is in `approval.ts`; this module never reads a clock it was not
//     handed.
import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  decodeMachineOpV1,
  type MachineCommandV1,
  type MachineOpV1,
} from "@frockbot/machine-protocol";

/**
 * The approval id — and therefore the command id — one Turn's `effectId` maps
 * to.
 *
 * `effectId` is `tool:<turn>:<step>:<ordinal>`, and an `approvalId` may not
 * carry a colon: it becomes a URL path segment and a durable storage key, and
 * `decodeSendToUserPayloadV1` refuses anything but letters, digits, dot,
 * underscore and dash. The mapping is total, deterministic and injective over
 * that format, so `commandId === approvalId` is still exactly one identity per
 * durable occurrence — which is all the idempotency rests on.
 */
export function machineApprovalIdV1(effectId: string): string {
  const mapped = effectId.replace(/[^a-zA-Z0-9._-]/g, ".");
  return /^[a-zA-Z0-9]/.test(mapped) ? mapped : `m${mapped}`;
}

/** One intent per approval, in the Bot Durable Object's own storage. */
export const MACHINE_INTENT_PREFIX = "machine-command:";

export function machineIntentKeyV1(approvalId: string): string {
  return `${MACHINE_INTENT_PREFIX}${approvalId}`;
}

/**
 * What the settlement did with the intent, once a person (or the clock)
 * answered. `refused` is the queue's own answer — a machine revoked between the
 * card and the decision — and is a fact about the command, not about the User.
 */
export type MachineIntentOutcomeV1 =
  "dispatched" | "duplicate" | "denied" | "expired" | "refused";

export const MACHINE_INTENT_OUTCOMES_V1: readonly MachineIntentOutcomeV1[] = [
  "dispatched",
  "duplicate",
  "denied",
  "expired",
  "refused",
];

/**
 * The durable record of one asked-for machine command.
 *
 * `decision` is what the User's answer was; `outcome` is what this Package then
 * did about it. They are separate because "approved" and "queued" are different
 * facts: an approval whose machine was revoked in between is `approved` and
 * `refused`, and a reader months later should be able to tell.
 */
export interface MachineIntentRecordV1 {
  schemaVersion: 1;
  approvalId: string;
  commandId: string;
  machineId: string;
  botId: string;
  runId: string;
  turn: number;
  op: MachineOpV1;
  createdAt: string;
  decision?: "approved" | "denied" | "expired";
  decidedAt?: string;
  dispatchedAt?: string;
  outcome?: MachineIntentOutcomeV1;
  /** Why the dispatch refused, in the queue's own words. */
  reason?: string;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new MachineDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MachineDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new MachineDecodeError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const stamp = text(value, 64, label);
  if (Number.isNaN(Date.parse(stamp))) {
    throw new MachineDecodeError(`${label} is not a timestamp`);
  }
  return stamp;
}

function decision(
  value: unknown,
  label: string,
): "approved" | "denied" | "expired" {
  if (value !== "approved" && value !== "denied" && value !== "expired") {
    throw new MachineDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeMachineIntentRecordV1(
  input: unknown,
  label = "machine intent",
): MachineIntentRecordV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "schemaVersion",
      "approvalId",
      "commandId",
      "machineId",
      "botId",
      "runId",
      "turn",
      "op",
      "createdAt",
      "decision",
      "decidedAt",
      "dispatchedAt",
      "outcome",
      "reason",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new MachineDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    typeof value.turn !== "number" ||
    !Number.isSafeInteger(value.turn) ||
    value.turn < 0
  ) {
    throw new MachineDecodeError(`${label} turn is invalid`);
  }
  if (
    value.outcome !== undefined &&
    !MACHINE_INTENT_OUTCOMES_V1.includes(
      value.outcome as MachineIntentOutcomeV1,
    )
  ) {
    throw new MachineDecodeError(`${label} outcome is invalid`);
  }
  const identifier = MACHINE_LIMITS_V1.identifier;
  return {
    schemaVersion: 1,
    approvalId: text(value.approvalId, identifier, `${label} approvalId`),
    commandId: text(value.commandId, identifier, `${label} commandId`),
    machineId: text(value.machineId, identifier, `${label} machineId`),
    botId: text(value.botId, identifier, `${label} botId`),
    runId: text(value.runId, identifier, `${label} runId`),
    turn: value.turn,
    op: decodeMachineOpV1(value.op, `${label} op`),
    createdAt: timestamp(value.createdAt, `${label} createdAt`),
    ...(value.decision === undefined
      ? {}
      : { decision: decision(value.decision, `${label} decision`) }),
    ...(value.decidedAt === undefined
      ? {}
      : { decidedAt: timestamp(value.decidedAt, `${label} decidedAt`) }),
    ...(value.dispatchedAt === undefined
      ? {}
      : {
          dispatchedAt: timestamp(value.dispatchedAt, `${label} dispatchedAt`),
        }),
    ...(value.outcome === undefined
      ? {}
      : { outcome: value.outcome as MachineIntentOutcomeV1 }),
    ...(value.reason === undefined
      ? {}
      : {
          reason: text(
            value.reason,
            MACHINE_LIMITS_V1.message,
            `${label} reason`,
          ),
        }),
  };
}

/**
 * The command an approved intent dispatches.
 *
 * `commandId` is carried over rather than minted, which is the whole
 * idempotency story: a settlement replayed after an eviction builds the
 * byte-identical command and the queue answers `duplicate`.
 */
export function machineCommandForIntentV1(
  intent: MachineIntentRecordV1,
  issuedAt: string,
): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId: intent.commandId,
    machineId: intent.machineId,
    botId: intent.botId,
    runId: intent.runId,
    turn: intent.turn,
    approvalId: intent.approvalId,
    op: intent.op,
    issuedAt,
    status: "queued",
  };
}

/**
 * The intent as the settling transaction leaves it.
 *
 * First write wins here too: an intent that already carries a decision is
 * returned unchanged, so an alarm racing a person cannot overwrite the answer
 * the person gave.
 */
export function settledMachineIntentV1(
  intent: MachineIntentRecordV1,
  answer: "approved" | "denied" | "expired",
  at: string,
): MachineIntentRecordV1 {
  if (intent.decision !== undefined) return intent;
  return {
    ...intent,
    decision: answer,
    decidedAt: at,
    // A denial or an expiry is terminal at the moment it is recorded: nothing
    // is dispatched, and there is no later step to wait for.
    ...(answer === "approved" ? {} : { outcome: answer }),
  };
}

/** The intent once the queue has answered a dispatch. */
export function dispatchedMachineIntentV1(
  intent: MachineIntentRecordV1,
  outcome: MachineIntentOutcomeV1,
  at: string,
  reason?: string,
): MachineIntentRecordV1 {
  return {
    ...intent,
    ...(outcome === "refused" ? {} : { dispatchedAt: at }),
    outcome,
    ...(reason === undefined
      ? {}
      : { reason: reason.slice(0, MACHINE_LIMITS_V1.message) }),
  };
}

/** The sentence the approval card puts in front of the User. */
export function machineApprovalActionV1(
  op: MachineOpV1,
  label: string,
): string {
  switch (op.kind) {
    case "exec":
      return `Run on ${label}: ${op.command}${op.cwd === undefined ? "" : ` (in ${op.cwd})`}`;
    case "read":
      return `Read ${op.path} from ${label}`;
    case "copy-to-computer":
      return `Copy ${op.path} from ${label} into the Computer workspace at ${op.workspacePath}`;
    case "copy-from-computer":
      return `Copy ${op.workspacePath} from the Computer workspace onto ${label} at ${op.path}`;
    case "messages":
      // Row 57g. Only `send` ever reaches a card — the six reads are exempt —
      // but the sentence is written for the whole variant so a later call that
      // does take one cannot fall through to something vague. The card carries
      // the *exact text*, because approving a message you have not read is not
      // approving anything.
      return op.call.kind === "send"
        ? `Send an iMessage from ${label} to ${op.call.to}: "${op.call.text}"`
        : `Read Messages on ${label} (${op.call.kind})`;
  }
}

/** Why the card is being shown, in the words the User reads under the action. */
export function machineApprovalRationaleV1(
  op: MachineOpV1,
  label: string,
): string {
  if (op.kind === "exec") {
    return `This runs on your own machine "${label}", outside the Computer sandbox, with your account's permissions.`;
  }
  if (op.kind === "messages") {
    return `This sends from Messages.app on your own machine "${label}", as you. The person receiving it sees a message from you, and it cannot be unsent.`;
  }
  return `This touches the filesystem of your own machine "${label}", which is separate from the Computer workspace.`;
}
