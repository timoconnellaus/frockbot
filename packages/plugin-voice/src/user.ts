import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";
import type { Plugin } from "cordis";
import { askBotFromVoiceV1, type VoiceAskHostV1 } from "./ask.js";
import { VoiceLedgerV1, type VoiceLedgerStorageV1 } from "./ledger.js";
import { executeVoiceToolV1, type VoiceToolHostV1 } from "./tools.js";
import type {
  VoiceOfflineReasonV1,
  VoicePendingAnswerV1,
  VoiceToolCallEntryV1,
  VoiceTranscriptEntryV1,
} from "./shared.js";

export interface VoiceUserBackendHostV1
  extends Omit<VoiceToolHostV1, "askBot">, VoiceAskHostV1 {
  storage: VoiceLedgerStorageV1;
  userId(): string;
}

export class VoiceUserBackendContributionV1 {
  readonly packageId = "voice";
  readonly ledger: VoiceLedgerV1;

  constructor(private readonly host: VoiceUserBackendHostV1) {
    this.ledger = new VoiceLedgerV1(host.storage);
  }

  start(input: { sessionId: string; deviceId: string; at: string }) {
    return this.ledger.start(input);
  }

  end(input: {
    sessionId: string;
    at: string;
    reason: VoiceOfflineReasonV1;
    seconds: number;
  }) {
    return this.ledger.end(input);
  }

  saveResumptionHandle(input: {
    sessionId: string;
    handle: string;
    at: string;
  }) {
    return this.ledger.saveResumptionHandle(input);
  }

  appendTranscript(sessionId: string, entry: VoiceTranscriptEntryV1) {
    return this.ledger.appendTranscript(sessionId, entry);
  }

  async executeTool(input: {
    sessionId: string;
    callId: string;
    name: string;
    args?: unknown;
    at: string;
  }) {
    const executed = await executeVoiceToolV1(
      {
        ...this.host,
        askBot: (ask) =>
          askBotFromVoiceV1(this.ledger, this.host, {
            userId: this.host.userId(),
            ...ask,
          }),
      },
      {
        name: input.name,
        args: input.args,
        context: {
          sessionId: input.sessionId,
          callId: input.callId,
          at: input.at,
        },
      },
    );
    await this.ledger.appendToolCall(input.sessionId, {
      schemaVersion: 1,
      id: input.callId,
      name: executed.name,
      label: executed.label,
      at: input.at,
    } satisfies VoiceToolCallEntryV1);
    return executed;
  }

  recordPendingAnswer(answer: VoicePendingAnswerV1) {
    return this.ledger.recordPendingAnswer(answer);
  }

  recordAnswerDelivery(delivery: import("./shared.js").VoiceAnswerDeliveryV1) {
    return delivery.outcome === "answered"
      ? this.ledger.recordAnswered({
          schemaVersion: 1,
          type: "voice/answered",
          askId: delivery.askId,
          botId: delivery.botId,
          runId: delivery.runId,
          answer: delivery.answer,
          answeredAt: delivery.at,
        })
      : this.ledger.recordFailed({
          schemaVersion: 1,
          type: "voice/failed",
          askId: delivery.askId,
          botId: delivery.botId,
          runId: delivery.runId,
          reason: delivery.reason,
          failedAt: delivery.at,
        });
  }

  markBriefed(input: {
    askIds: readonly string[];
    sessionId: string;
    at: string;
  }) {
    return this.ledger.markBriefed(input);
  }

  view() {
    return this.ledger.view();
  }
}

export interface VoiceUserApplicationHostV1 {
  voice: VoiceUserBackendHostV1;
}

export function createVoiceUserBackendPluginV1(
  host: VoiceUserBackendHostV1,
  lifecycle: { mount(value: VoiceUserBackendContributionV1): () => void },
): Plugin {
  return () => lifecycle.mount(new VoiceUserBackendContributionV1(host));
}

export const userContribution = defineUserBackendContribution<
  VoiceUserApplicationHostV1,
  VoiceUserBackendContributionV1
>({
  specifier: "@frockbot/plugin-voice/user",
  create: (host, lifecycle) =>
    createVoiceUserBackendPluginV1(host.voice, lifecycle),
});
