import type { SessionEvent } from "@frockbot/kernel-contracts";
import { modelCostMicrosV1 } from "./pricing.js";
import {
  decodeUsageEntryV1,
  USAGE_OUTBOX_MAX_V1,
  type UsageEntryV1,
} from "./shared.js";

export interface UsageSinkV1 {
  recordEntries(entries: readonly UsageEntryV1[]): Promise<void>;
}

export function usageEntriesFromTurnV1(input: {
  botId: string;
  runId: string;
  turn: number;
  events: readonly SessionEvent[];
}): UsageEntryV1[] {
  return input.events.flatMap((event) => {
    if (event.type !== "model/usage" || event.turn !== input.turn) return [];
    const priced = modelCostMicrosV1(event.provider, event.model, event);
    return [
      {
        schemaVersion: 1,
        entryId: `${input.botId}:${input.runId}:${event.requestId}`,
        kind: "model",
        botId: input.botId,
        runId: input.runId,
        turnId: `${input.runId}:${input.turn}`,
        turn: input.turn,
        requestId: event.requestId,
        at: event.timestamp,
        provider: event.provider,
        model: event.model,
        ...(event.modelBinding
          ? { bindingId: event.modelBinding.connectionId }
          : {}),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens ?? 0,
        reasoningTokens: event.reasoningTokens ?? 0,
        voiceSeconds: 0,
        latencyMs: event.latencyMs,
        estimated: event.estimated,
        unknownPrice: priced.unknown,
        priceTableVersion: priced.priceTableVersion,
        costMicros: priced.costMicros,
      },
    ];
  });
}

export const USAGE_OUTBOX_KEY_V1 = "billing:usage-outbox";

export interface UsageOutboxStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface StoredUsageOutboxV1 {
  schemaVersion: 1;
  entries: UsageEntryV1[];
  truncated: boolean;
}

function decodeOutboxV1(value: unknown): StoredUsageOutboxV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: 1, entries: [], truncated: false };
  }
  const candidate = value as Partial<StoredUsageOutboxV1>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries)) {
    return { schemaVersion: 1, entries: [], truncated: true };
  }
  const entries: UsageEntryV1[] = [];
  for (const entry of candidate.entries.slice(-USAGE_OUTBOX_MAX_V1)) {
    try {
      entries.push(decodeUsageEntryV1(entry));
    } catch {
      // A bad derived entry is dropped while the durable model/usage event
      // remains rebuildable; the marker makes the gap visible.
    }
  }
  return {
    schemaVersion: 1,
    entries,
    truncated:
      candidate.truncated === true ||
      candidate.entries.length !== entries.length,
  };
}

export class UsageOutboxV1 {
  constructor(private readonly storage: UsageOutboxStorageV1) {}

  async append(entries: readonly UsageEntryV1[]): Promise<void> {
    if (entries.length === 0) return;
    const stored = decodeOutboxV1(
      await this.storage.get<unknown>(USAGE_OUTBOX_KEY_V1),
    );
    const merged = [...stored.entries, ...entries.map(decodeUsageEntryV1)];
    await this.storage.put(USAGE_OUTBOX_KEY_V1, {
      schemaVersion: 1,
      entries: merged.slice(-USAGE_OUTBOX_MAX_V1),
      truncated: stored.truncated || merged.length > USAGE_OUTBOX_MAX_V1,
    } satisfies StoredUsageOutboxV1);
  }

  async drain(sink: UsageSinkV1): Promise<void> {
    const stored = decodeOutboxV1(
      await this.storage.get<unknown>(USAGE_OUTBOX_KEY_V1),
    );
    if (stored.entries.length === 0) return;
    await sink.recordEntries(stored.entries);
    await this.storage.delete(USAGE_OUTBOX_KEY_V1);
  }

  async state(): Promise<{ pending: number; truncated: boolean }> {
    const stored = decodeOutboxV1(
      await this.storage.get<unknown>(USAGE_OUTBOX_KEY_V1),
    );
    return { pending: stored.entries.length, truncated: stored.truncated };
  }
}
