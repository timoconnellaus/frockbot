// The one message that travels from the User Durable Object back to a Bot.
//
// A machine answers the backend, not the Bot: the result lands on the User
// object, which is the queue's authority. The Bot is owed the fact that it
// landed, and it is owed it durably — "its outcome is delivered to the Bot's
// next conversational Turn as durable input" — so the User object hands the Bot
// this, and the Bot enqueues a `PendingBotInputV1` from it.
//
// It carries a *preview*, never the output. A machine command may return a
// megabyte of stdout, and a preamble line that carried it would push a person's
// own words out of the model's context to say something the Bot can read in
// full whenever it wants, with `machine_command_check`.
import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  MACHINE_COMMAND_OUTCOMES_V1,
  type MachineCommandOutcomeV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
} from "@frockbot/machine-protocol";

/** The longest preview a delivery carries. One line, not a transcript. */
export const MACHINE_RESULT_PREVIEW_MAX = 400;

export interface MachineResultDeliveryV1 {
  schemaVersion: 1;
  botId: string;
  runId: string;
  machineId: string;
  commandId: string;
  outcome: MachineCommandOutcomeV1;
  finishedAt: string;
  preview: string;
}

/** A single readable line about what the machine said. Pure. */
export function machineResultPreviewV1(result: MachineCommandResultV1): string {
  const parts: string[] = [];
  if (result.exitCode !== undefined) parts.push(`exit ${result.exitCode}`);
  const text =
    result.message ??
    (result.stdout && result.stdout.length > 0
      ? result.stdout
      : (result.stderr ?? ""));
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length > 0) parts.push(flattened);
  if (result.truncated) parts.push("(output truncated)");
  if (result.bytesBase64 !== undefined) {
    parts.push(`(${result.bytesBase64.length} base64 characters returned)`);
  }
  const joined = parts.join(" — ");
  return (joined.length === 0 ? result.outcome : joined).slice(
    0,
    MACHINE_RESULT_PREVIEW_MAX,
  );
}

/** The delivery one recorded result owes the Bot that asked for it. Pure. */
export function machineResultDeliveryV1(
  command: MachineCommandV1,
  result: MachineCommandResultV1,
): MachineResultDeliveryV1 {
  return {
    schemaVersion: 1,
    botId: command.botId,
    runId: command.runId,
    machineId: command.machineId,
    commandId: result.commandId,
    outcome: result.outcome,
    finishedAt: result.finishedAt,
    preview: machineResultPreviewV1(result),
  };
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

export function decodeMachineResultDeliveryV1(
  input: unknown,
  label = "machine result delivery",
): MachineResultDeliveryV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "botId",
    "runId",
    "machineId",
    "commandId",
    "outcome",
    "finishedAt",
    "preview",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new MachineDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new MachineDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    typeof value.outcome !== "string" ||
    !MACHINE_COMMAND_OUTCOMES_V1.includes(
      value.outcome as MachineCommandOutcomeV1,
    )
  ) {
    throw new MachineDecodeError(`${label} outcome is invalid`);
  }
  const finishedAt = text(value.finishedAt, 64, `${label} finishedAt`);
  if (Number.isNaN(Date.parse(finishedAt))) {
    throw new MachineDecodeError(`${label} finishedAt is not a timestamp`);
  }
  return {
    schemaVersion: 1,
    botId: text(value.botId, MACHINE_LIMITS_V1.identifier, `${label} botId`),
    runId: text(value.runId, MACHINE_LIMITS_V1.identifier, `${label} runId`),
    machineId: text(
      value.machineId,
      MACHINE_LIMITS_V1.identifier,
      `${label} machineId`,
    ),
    commandId: text(
      value.commandId,
      MACHINE_LIMITS_V1.identifier,
      `${label} commandId`,
    ),
    outcome: value.outcome as MachineCommandOutcomeV1,
    finishedAt,
    preview: text(
      value.preview,
      MACHINE_RESULT_PREVIEW_MAX,
      `${label} preview`,
    ),
  };
}
