// The bounded per-User machine quota.
//
// "Quotas refuse visibly": exceeding one refuses the operation and records a
// visible failure, so this module never throws for a breach. It returns an
// outcome, exactly as `plugin-skills/src/quota.ts` does, and the caller turns
// that outcome into an `isError` tool result whose text `plugin-audit`
// classifies as `refused` rather than `error`.
//
// Three things are bounded, and each bounds a different loss:
//
//  - **machines per User** — the registry is a projection the settings section
//    renders and a tool lists; unbounded, it is an unbounded response.
//  - **commands queued for one machine** — the queue lives in the User Durable
//    Object and is drained by a laptop that may be asleep for a week.
//  - **commands per User per day** — the one bound on a Bot that has learned
//    to ask for approval often. It is a rate, so it needs a durable counter
//    the User Durable Object keeps; this module only says whether the number
//    it is handed is over.

import { MACHINE_LIMITS_V1 } from "./protocol.js";

export interface MachineQuotaConfigV1 {
  schemaVersion: 1;
  /** Machines one User may hold registered at once. */
  maxMachinesPerUser: number;
  /** Commands one machine may hold queued at once. */
  maxQueuedCommands: number;
  /** Commands one User may dispatch across all machines in a day. */
  maxCommandsPerDay: number;
}

export const MACHINE_QUOTA_DEFAULTS_V1: MachineQuotaConfigV1 = {
  schemaVersion: 1,
  maxMachinesPerUser: MACHINE_LIMITS_V1.maxMachinesPerUser,
  maxQueuedCommands: MACHINE_LIMITS_V1.maxQueue,
  maxCommandsPerDay: MACHINE_LIMITS_V1.commandsPerDay,
};

export type MachineQuotaLimitV1 =
  "machine-count" | "queue-depth" | "commands-per-day";

export type MachineQuotaRequestV1 =
  | { kind: "register"; registeredMachines: number }
  | { kind: "dispatch"; queuedCommands: number; commandsToday: number };

export type MachineQuotaOutcomeV1 =
  | { status: "within" }
  | {
      status: "refused";
      limitName: MachineQuotaLimitV1;
      reason: string;
      used: number;
      limit: number;
    };

/**
 * Checks one registration or one dispatch against the quota. Never throws for
 * a breach: a quota breach is an observable outcome the tool result reports.
 */
export function checkMachineQuotaV1(
  request: MachineQuotaRequestV1,
  config: MachineQuotaConfigV1 = MACHINE_QUOTA_DEFAULTS_V1,
): MachineQuotaOutcomeV1 {
  if (request.kind === "register") {
    if (request.registeredMachines >= config.maxMachinesPerUser) {
      return {
        status: "refused",
        limitName: "machine-count",
        reason: `this account holds ${request.registeredMachines} registered machines; the quota allows ${config.maxMachinesPerUser}`,
        used: request.registeredMachines,
        limit: config.maxMachinesPerUser,
      };
    }
    return { status: "within" };
  }
  if (request.queuedCommands >= config.maxQueuedCommands) {
    return {
      status: "refused",
      limitName: "queue-depth",
      reason: `this machine already has ${request.queuedCommands} commands waiting; the quota allows ${config.maxQueuedCommands}`,
      used: request.queuedCommands,
      limit: config.maxQueuedCommands,
    };
  }
  if (request.commandsToday >= config.maxCommandsPerDay) {
    return {
      status: "refused",
      limitName: "commands-per-day",
      reason: `this account has sent ${request.commandsToday} machine commands today; the quota allows ${config.maxCommandsPerDay}`,
      used: request.commandsToday,
      limit: config.maxCommandsPerDay,
    };
  }
  return { status: "within" };
}

/**
 * The refusal a tool result carries.
 *
 * The leading "Refused:" is not decoration. `plugin-audit`'s `outcomeFor`
 * classifies an `isError` result by its text
 * (`/\brefus|not allowed|denied|blocked while\b/i`, `plugin-audit/src/bot.ts`),
 * so a quota breach that does not say it refused would be audited as an effect
 * that ran and failed — which is a materially different fact about somebody's
 * laptop.
 */
export function machineQuotaRefusalV1(
  outcome: Extract<MachineQuotaOutcomeV1, { status: "refused" }>,
): string {
  return `Refused: ${outcome.reason}.`;
}

export function decodeMachineQuotaConfigV1(
  input: unknown,
  label = "machine quota configuration",
): MachineQuotaConfigV1 {
  if (input === undefined) return { ...MACHINE_QUOTA_DEFAULTS_V1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "maxMachinesPerUser",
    "maxQueuedCommands",
    "maxCommandsPerDay",
  ];
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} is invalid`);
  }
  const bounded = (name: string, maximum: number): number => {
    const candidate = value[name];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > maximum
    ) {
      throw new Error(`${label}.${name} is out of range`);
    }
    return candidate as number;
  };
  return {
    schemaVersion: 1,
    maxMachinesPerUser: bounded("maxMachinesPerUser", 64),
    maxQueuedCommands: bounded("maxQueuedCommands", 256),
    maxCommandsPerDay: bounded("maxCommandsPerDay", 10_000),
  };
}
