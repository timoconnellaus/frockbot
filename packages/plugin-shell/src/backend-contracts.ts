import type { SessionEvent } from "@frockbot/agent-core";
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

export function requireStoredRunV1(input: StoredRun): StoredRun {
  const candidate = input as Partial<StoredRun>;
  if (!candidate.status || !STORED_RUN_STATUSES.includes(candidate.status)) {
    throw new Error(
      `run "${candidate.runId ?? "unknown"}" has no valid status`,
    );
  }
  if (!candidate.phase || !STORED_RUN_PHASES.includes(candidate.phase)) {
    throw new Error(`run "${candidate.runId ?? "unknown"}" has no valid phase`);
  }
  if (
    !Number.isSafeInteger(candidate.previousEventCount) ||
    (candidate.previousEventCount ?? -1) < 0
  ) {
    throw new Error(
      `run "${candidate.runId ?? "unknown"}" has no valid previous event count`,
    );
  }
  if (!candidate.configurationSnapshot) {
    throw new Error(
      `run "${candidate.runId ?? "unknown"}" has no configuration snapshot`,
    );
  }
  decodeBotSettingsViewV1(candidate.configurationSnapshot);
  return input;
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
