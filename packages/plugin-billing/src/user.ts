import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";
import type { Plugin } from "cordis";
import {
  voiceIncrementCostMicrosV1,
  MODEL_PRICE_TABLE_VERSION_V1,
} from "./pricing.js";
import {
  decodeUsageEntryV1,
  USAGE_ENTRY_PAGE_MAX_V1,
  type UsageEntryV1,
  type UsageReportV1,
} from "./shared.js";
import { UsageStoreV1, type UsageSqlV1 } from "./store.js";

export interface BillingUserBackendHostV1 {
  sql: UsageSqlV1;
  transactionSync?<T>(closure: () => T): T;
  now?: () => number;
}

interface VoiceEntryInputV1 {
  day: string;
  sessionId: string;
  sessionSeconds: number;
  recordedSeconds: number;
  at: string;
}

export class BillingUserBackendContribution {
  readonly packageId = "billing";
  private readonly store: UsageStoreV1;

  constructor(host: BillingUserBackendHostV1) {
    this.store = new UsageStoreV1(host);
  }

  recordEntries(input: unknown): { recorded: number; quarantined: number } {
    if (!Array.isArray(input) || input.length > USAGE_ENTRY_PAGE_MAX_V1) {
      throw new Error("usage entry page is invalid");
    }
    const entries: UsageEntryV1[] = [];
    let quarantined = 0;
    for (const candidate of input) {
      try {
        entries.push(decodeUsageEntryV1(candidate));
      } catch {
        quarantined += 1;
      }
    }
    return { recorded: this.store.record(entries), quarantined };
  }

  private voiceEntry(input: VoiceEntryInputV1): UsageEntryV1 {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      !input.sessionId ||
      !Number.isSafeInteger(input.sessionSeconds) ||
      input.sessionSeconds <= 0 ||
      !Number.isSafeInteger(input.recordedSeconds) ||
      input.recordedSeconds <= 0 ||
      input.recordedSeconds > input.sessionSeconds ||
      !Number.isFinite(Date.parse(input.at))
    ) {
      throw new Error("voice usage is invalid");
    }
    return {
      schemaVersion: 1,
      entryId: `voice:${input.day}:${input.sessionId}:${input.sessionSeconds}`,
      kind: "voice",
      at: input.at,
      provider: "openai",
      model: "gpt-live-transcribe",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      voiceSeconds: input.recordedSeconds,
      latencyMs: 0,
      estimated: false,
      unknownPrice: false,
      priceTableVersion: MODEL_PRICE_TABLE_VERSION_V1,
      costMicros: voiceIncrementCostMicrosV1(
        input.sessionSeconds,
        input.recordedSeconds,
      ),
    };
  }

  recordVoice(input: VoiceEntryInputV1): {
    recorded: number;
  } {
    return { recorded: this.store.record([this.voiceEntry(input)]) };
  }

  recordVoiceInCurrentTransaction(input: VoiceEntryInputV1): {
    recorded: number;
  } {
    return {
      recorded: this.store.recordInCurrentTransaction([this.voiceEntry(input)]),
    };
  }

  report(): UsageReportV1 {
    return this.store.report();
  }
}

export interface BillingUserApplicationHostV1 {
  billing: BillingUserBackendHostV1;
}

export const userContribution = defineUserBackendContribution<
  BillingUserApplicationHostV1,
  BillingUserBackendContribution
>({
  specifier: "@frockbot/plugin-billing/user",
  create: (host, lifecycle) => {
    const contribution = new BillingUserBackendContribution(host.billing);
    return () => lifecycle.mount(contribution);
  },
});

export function createBillingUserBackendPlugin(
  host: BillingUserBackendHostV1,
  lifecycle: { mount(value: BillingUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(new BillingUserBackendContribution(host));
}
