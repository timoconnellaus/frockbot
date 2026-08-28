import type { SessionEvent } from "@frockbot/agent-core";
import type { BotSettingsViewV1 } from "@frockbot/configuration-core";

export type StoredRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "reconciliation-required";

export interface StoredRun {
  runId: string;
  commandFingerprint: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: SessionEvent[];
  status?: StoredRunStatus;
  responseText?: string;
  failure?: string;
  phase?: "admitted" | "executing" | "reconciliation-required";
  configurationSnapshot?: BotSettingsViewV1;
  previousEventCount?: number;
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

export interface BotTurnResult {
  runId: string;
  text: string;
  events: SessionEvent[];
  notification?: BotNotificationIntent;
}
