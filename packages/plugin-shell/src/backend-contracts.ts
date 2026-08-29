import { decodeSessionEvent, type SessionEvent } from "@frockbot/agent-core";
import {
  decodeBotSettingsViewV1,
  type BotSettingsViewV1,
} from "@frockbot/configuration-core";

export type StoredRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "reconciliation-required";

export type StoredRunPhase =
  "admitted" | "executing" | "reconciliation-required";

export interface StoredRun {
  runId: string;
  commandFingerprint: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: SessionEvent[];
  status: StoredRunStatus;
  responseText?: string;
  failure?: string;
  phase: StoredRunPhase;
  configurationSnapshot: BotSettingsViewV1;
  previousEventCount: number;
}

const STORED_RUN_STATUSES: readonly StoredRunStatus[] = [
  "running",
  "completed",
  "failed",
  "interrupted",
  "reconciliation-required",
];
const STORED_RUN_PHASES: readonly StoredRunPhase[] = [
  "admitted",
  "executing",
  "reconciliation-required",
];
const STORED_RUN_REQUIRED_KEYS = [
  "runId",
  "commandFingerprint",
  "sessionId",
  "acceptedAt",
  "input",
  "events",
  "status",
  "phase",
  "configurationSnapshot",
  "previousEventCount",
] as const;
const STORED_RUN_OPTIONAL_KEYS = ["responseText", "failure"] as const;

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum
  );
}

function decodeStoredRunEvents(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new Error("stored run has invalid events");
  return value.map(decodeSessionEvent);
}

export function requireStoredRunV1(input: unknown): StoredRun {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("stored run is invalid");
  }
  const candidate = input as Record<string, unknown>;
  const allowed = new Set<string>([
    ...STORED_RUN_REQUIRED_KEYS,
    ...STORED_RUN_OPTIONAL_KEYS,
  ]);
  if (
    !STORED_RUN_REQUIRED_KEYS.every((key) => Object.hasOwn(candidate, key)) ||
    !Object.keys(candidate).every((key) => allowed.has(key))
  ) {
    throw new Error("stored run has invalid fields");
  }
  if (
    !boundedString(candidate.runId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(candidate.runId)
  ) {
    throw new Error("stored run has invalid runId");
  }
  const runId = candidate.runId;
  if (!boundedString(candidate.commandFingerprint, 65_536)) {
    throw new Error(`run "${runId}" has no valid command fingerprint`);
  }
  if (!boundedString(candidate.sessionId, 257)) {
    throw new Error(`run "${runId}" has no valid session id`);
  }
  if (
    !boundedString(candidate.acceptedAt, 64) ||
    !Number.isFinite(Date.parse(candidate.acceptedAt))
  ) {
    throw new Error(`run "${runId}" has no valid acceptance time`);
  }
  if (!boundedString(candidate.input, 32_000)) {
    throw new Error(`run "${runId}" has no valid input`);
  }
  const events = decodeStoredRunEvents(candidate.events);
  const status = STORED_RUN_STATUSES.find(
    (value) => value === candidate.status,
  );
  if (!status) {
    throw new Error(`run "${runId}" has no valid status`);
  }
  const phase = STORED_RUN_PHASES.find((value) => value === candidate.phase);
  if (!phase) {
    throw new Error(`run "${runId}" has no valid phase`);
  }
  if (
    !Number.isSafeInteger(candidate.previousEventCount) ||
    (candidate.previousEventCount as number) < 0
  ) {
    throw new Error(`run "${runId}" has no valid previous event count`);
  }
  decodeBotSettingsViewV1(candidate.configurationSnapshot);
  for (const key of STORED_RUN_OPTIONAL_KEYS) {
    if (
      candidate[key] !== undefined &&
      !boundedString(candidate[key], 32_000, true)
    ) {
      throw new Error(`run "${runId}" has invalid ${key}`);
    }
  }
  if (status === "completed" && candidate.responseText === undefined) {
    throw new Error(`run "${runId}" has no response text`);
  }
  if (
    (status === "failed" || status === "reconciliation-required") &&
    candidate.failure === undefined
  ) {
    throw new Error(`run "${runId}" has no failure`);
  }
  return {
    runId,
    commandFingerprint: candidate.commandFingerprint,
    sessionId: candidate.sessionId,
    acceptedAt: candidate.acceptedAt,
    input: candidate.input,
    events,
    status,
    phase,
    configurationSnapshot: candidate.configurationSnapshot as BotSettingsViewV1,
    previousEventCount: candidate.previousEventCount as number,
    ...(candidate.responseText === undefined
      ? {}
      : { responseText: candidate.responseText as string }),
    ...(candidate.failure === undefined
      ? {}
      : { failure: candidate.failure as string }),
  };
}

export interface BotTurnCommand {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  text: string;
}

export function botTurnCommandFingerprintV1(
  command: BotTurnCommand & { userId: string; botId: string },
): string {
  return `bot-turn-command-v1:${JSON.stringify({
    userId: command.userId,
    botId: command.botId,
    sessionId: command.sessionId,
    text: command.text,
  })}`;
}

export interface BotNotificationIntent {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
}

export interface BotTurnCompletion {
  runId: string;
  text: string;
  events: SessionEvent[];
  notification?: BotNotificationIntent;
}
