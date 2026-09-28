// A Routine change a Bot or a Plugin proposes, waiting on the person.
//
// A Routine the person wrote is their standing request: its prompt authorizes
// what it names, every time it fires. So a Bot that could write one — or
// rewrite, pause or delete one of theirs — by its own say-so would be granting
// itself standing authority. `routine_manage` therefore records the exact
// command here and puts an approval card on the Turn's log; nothing is armed.
// When the person approves, the settlement reads *this* record — never what
// the Bot says later — and applies the command with the Approval recorded on
// the Routine, which is what makes it fire as the person's (`promptBy`
// "user").
//
// The shape is the Plugin intent's (`app/plugins/approval.ts`): the id is
// derived from the Turn's durable occurrence, the record is durable before
// the card, and it is settled inside the decision's transaction and applied
// after it.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  ROUTINE_APPROVAL_ID_PREFIX_V1,
  SEND_TO_USER_LIMITS_V1,
  type SendToUserApprovalRiskV1,
} from "@frockbot/core/contracts";
import { describeRoutineScheduleV1 } from "./cron.js";
import { RoutineDecodeError, type RoutineTriggerV1 } from "./records.js";
import { decodeRoutineCommandV1, type RoutineCommandV1 } from "./shared.js";

export const ROUTINE_INTENT_PREFIX = "routine:intent:";

export function routineIntentKeyV1(approvalId: string): string {
  return `${ROUTINE_INTENT_PREFIX}${approvalId}`;
}

/** The Approval one durable occurrence asks under. */
export async function routineApprovalIdV1(
  runId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(`${runId}\u0000${effectId}`);
  return `${ROUTINE_APPROVAL_ID_PREFIX_V1}${digest.slice(0, 32)}`;
}

export type RoutineIntentDecisionV1 = "approved" | "denied" | "expired";

export interface RoutineIntentRecordV1 {
  schemaVersion: 1;
  approvalId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  createdAt: string;
  /** Exactly what the person is asked to allow. */
  command: RoutineCommandV1;
  decision?: RoutineIntentDecisionV1;
  decidedAt?: string;
  /** What applying an approved command came to. */
  outcome?: { status: "applied" | "failed"; at: string; detail?: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RoutineDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeRoutineIntentRecordV1(
  value: unknown,
  label = "Routine intent",
): RoutineIntentRecordV1 {
  const candidate = record(value, label);
  const required = [
    "schemaVersion",
    "approvalId",
    "botId",
    "sessionId",
    "runId",
    "turnId",
    "createdAt",
    "command",
  ];
  const optional = ["decision", "decidedAt", "outcome"];
  for (const key of Object.keys(candidate)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new RoutineDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(candidate, key)) {
      throw new RoutineDecodeError(`${label} is missing "${key}"`);
    }
  }
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(`${label} schemaVersion is unsupported`);
  }
  const decision = candidate.decision;
  if (
    decision !== undefined &&
    decision !== "approved" &&
    decision !== "denied" &&
    decision !== "expired"
  ) {
    throw new RoutineDecodeError(`${label} decision is invalid`);
  }
  let outcome: RoutineIntentRecordV1["outcome"];
  if (candidate.outcome !== undefined) {
    const stored = record(candidate.outcome, `${label} outcome`);
    if (stored.status !== "applied" && stored.status !== "failed") {
      throw new RoutineDecodeError(`${label} outcome status is invalid`);
    }
    outcome = {
      status: stored.status,
      at: text(stored.at, 64, `${label} outcome at`),
      ...(stored.detail === undefined
        ? {}
        : { detail: text(stored.detail, 1_000, `${label} outcome detail`) }),
    };
  }
  return {
    schemaVersion: 1,
    approvalId: text(candidate.approvalId, 128, `${label} approvalId`),
    botId: text(candidate.botId, 256, `${label} botId`),
    sessionId: text(candidate.sessionId, 512, `${label} sessionId`),
    runId: text(candidate.runId, 256, `${label} runId`),
    turnId: text(candidate.turnId, 256, `${label} turnId`),
    createdAt: text(candidate.createdAt, 64, `${label} createdAt`),
    command: decodeRoutineCommandV1(candidate.command),
    ...(decision === undefined ? {} : { decision }),
    ...(candidate.decidedAt === undefined
      ? {}
      : { decidedAt: text(candidate.decidedAt, 64, `${label} decidedAt`) }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export interface RoutineIntentStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Record what a decision means for the Routine change it covers, in the
 * transaction that records the decision. `undefined` when the approval was
 * not a Routine change's.
 */
export async function settleRoutineIntentV1(
  transaction: RoutineIntentStorageV1,
  approvalId: string,
  decision: RoutineIntentDecisionV1,
  at: string,
): Promise<RoutineIntentRecordV1 | undefined> {
  if (!approvalId.startsWith(ROUTINE_APPROVAL_ID_PREFIX_V1)) return undefined;
  const key = routineIntentKeyV1(approvalId);
  const stored = await transaction.get<unknown>(key);
  if (stored === undefined) return undefined;
  const intent = decodeRoutineIntentRecordV1(stored);
  if (intent.decision !== undefined) return intent;
  const settled: RoutineIntentRecordV1 = { ...intent, decision, decidedAt: at };
  await transaction.put(key, settled);
  return settled;
}

/** Record what applying an approved change came to, once. */
export async function recordRoutineIntentOutcomeV1(
  storage: RoutineIntentStorageV1,
  approvalId: string,
  outcome: NonNullable<RoutineIntentRecordV1["outcome"]>,
): Promise<void> {
  const key = routineIntentKeyV1(approvalId);
  const stored = await storage.get<unknown>(key);
  if (stored === undefined) return;
  const intent = decodeRoutineIntentRecordV1(stored);
  if (intent.decision !== "approved" || intent.outcome !== undefined) return;
  await storage.put(key, { ...intent, outcome });
}

function timingWords(command: {
  schedule?: string;
  trigger?: RoutineTriggerV1;
}): string | undefined {
  if (command.schedule !== undefined) {
    const described = describeRoutineScheduleV1(command.schedule);
    return described === "Custom schedule"
      ? `on the schedule ${command.schedule}`
      : `${described.charAt(0).toLowerCase()}${described.slice(1)}`;
  }
  const trigger = command.trigger;
  if (!trigger) return undefined;
  if (trigger.kind === "webhook") return "whenever its webhook is called";
  if (trigger.kind === "plugin") {
    return `whenever the Plugin ${trigger.pluginId} hands it a ${trigger.trigger} delivery`;
  }
  return `on each ${trigger.triggerType} event from a connected app${trigger.config ? ` matching ${trigger.config.query}` : ""}`;
}

/** The room a card's rationale leaves for the prompt it shows whole. */
const RATIONALE_MAX = SEND_TO_USER_LIMITS_V1.rationale;

/**
 * The card's words: what the change arms or switches off, and the prompt it
 * would run, whole. `undefined` when the prompt cannot be shown whole on a
 * card — a person is never asked to approve words they cannot read.
 */
export function routineApprovalWordingV1(
  command: RoutineCommandV1,
  current?: { name: string; prompt: string },
):
  | { action: string; rationale?: string; risk: SendToUserApprovalRiskV1 }
  | undefined {
  const clip = (value: string, max: number) =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  const standing =
    "Once approved it runs as your standing request: whatever this prompt asks for, your Bot may do each time it fires, and anything irreversible or reaching someone else is still put to you on a card.";
  const withPrompt = (lead: string, prompt: string) => {
    const rationale = `${lead}\n\nIt runs this prompt:\n${prompt}`;
    return rationale.length <= RATIONALE_MAX ? rationale : undefined;
  };
  switch (command.type) {
    case "routine/create": {
      const rationale = withPrompt(standing, command.prompt);
      if (rationale === undefined) return undefined;
      const when = timingWords(command);
      return {
        action: clip(
          `Set up the Routine "${command.name}"${when ? `, running ${when}` : ""}`,
          SEND_TO_USER_LIMITS_V1.action,
        ),
        rationale,
        risk: "medium",
      };
    }
    case "routine/update": {
      const name = current?.name ?? command.routineId;
      const changes = [
        ...(command.prompt === undefined ? [] : ["its prompt"]),
        ...(command.schedule === undefined && command.trigger === undefined
          ? []
          : [`when it runs (${timingWords(command) ?? "unchanged"})`]),
        ...(command.name === undefined
          ? []
          : [`its name to "${command.name}"`]),
        ...(command.enabled === undefined
          ? []
          : [command.enabled ? "turning it on" : "turning it off"]),
      ];
      const rationale =
        command.prompt === undefined
          ? current === undefined
            ? standing
            : withPrompt(standing, current.prompt)
          : withPrompt(standing, command.prompt);
      if (rationale === undefined) return undefined;
      return {
        action: clip(
          `Change the Routine "${name}": ${changes.join(", ") || "nothing"}`,
          SEND_TO_USER_LIMITS_V1.action,
        ),
        rationale,
        risk: "medium",
      };
    }
    case "routine/pause":
      return {
        action: clip(
          `Pause the Routine "${current?.name ?? command.routineId}"`,
          SEND_TO_USER_LIMITS_V1.action,
        ),
        rationale:
          "You set this Routine up. Pausing stops it firing until it is resumed.",
        risk: "low",
      };
    case "routine/delete":
      return {
        action: clip(
          `Delete the Routine "${current?.name ?? command.routineId}"`,
          SEND_TO_USER_LIMITS_V1.action,
        ),
        rationale:
          "You set this Routine up. Deleting it removes it and its history for good.",
        risk: "medium",
      };
    default:
      return undefined;
  }
}

/** What the Turn that drained the decision is told the change came to. */
export function routineIntentDeliveryLineV1(
  intent: RoutineIntentRecordV1,
): string {
  const what =
    intent.command.type === "routine/create"
      ? `setting up the Routine "${intent.command.name}"`
      : `the change to Routine ${intent.command.routineId}`;
  if (intent.decision !== "approved") {
    return `It covered ${what}. Nothing was changed; do not make that change.`;
  }
  if (intent.outcome?.status === "failed") {
    return `It covered ${what}, which could not be applied: ${intent.outcome.detail ?? "the Routine refused it"}. Tell the person.`;
  }
  return `It covered ${what}, which is now applied as the person's own. Do not make it again.`;
}
