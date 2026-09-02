// The Bot Durable Object's run records are kernel authority; this module binds
// the kernel codec to the Shell Package's configuration snapshot decoder.
import {
  createStoredRunCodecV1,
  type StoredRunCodecV1,
  type StoredRunV1,
} from "@frockbot/kernel-do";
import {
  decodeBotSettingsViewV1,
  isPublicIdentifier,
  migrateStoredBotSettingsV1,
  type BotSettingsViewV1,
} from "@frockbot/configuration-core";

export {
  botStopCommandFingerprintV1,
  botTurnCommandFingerprintV1,
  type BotNotificationIntent,
  type BotStopCommand,
  type BotTurnCommand,
  type BotTurnCompletion,
  type StoredEffectAdmission,
  type StoredEffectAdmissionOutcome,
  type StoredRunPhase,
  type StoredRunStatus,
} from "@frockbot/kernel-do";

export type StoredRun = StoredRunV1<BotSettingsViewV1>;

export function decodeRunIdV1(value: unknown): string {
  if (!isPublicIdentifier(value)) {
    throw new Error("runId is invalid");
  }
  return value;
}

export const storedRunCodecV1: StoredRunCodecV1<BotSettingsViewV1> =
  createStoredRunCodecV1<BotSettingsViewV1>({
    decodeRunId: decodeRunIdV1,
    decodeConfigurationSnapshot: (stored) =>
      decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored)),
  });

export function requireStoredRunV1(input: unknown): StoredRun {
  return storedRunCodecV1.require(input);
}
