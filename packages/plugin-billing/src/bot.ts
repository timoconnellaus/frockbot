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
  if (
    !input.events.some(
      (event) => event.type === "turn/end" && event.turn === input.turn,
    )
  ) {
    return [];
  }
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
  private readonly maximum: number;

  constructor(
    private readonly storage: UsageOutboxStorageV1,
    options: { maximum?: number } = {},
  ) {
    this.maximum = options.maximum ?? USAGE_OUTBOX_MAX_V1;
  }

  private async read(): Promise<StoredUsageOutboxV1> {
    return decodeOutboxV1(await this.storage.get<unknown>(USAGE_OUTBOX_KEY_V1));
  }

  private async write(outbox: StoredUsageOutboxV1): Promise<void> {
    if (outbox.entries.length === 0 && !outbox.truncated) {
      await this.storage.delete(USAGE_OUTBOX_KEY_V1);
      return;
    }
    await this.storage.put(USAGE_OUTBOX_KEY_V1, outbox);
  }

  async append(entries: readonly UsageEntryV1[]): Promise<void> {
    if (entries.length === 0) return;
    const stored = await this.read();
    const seen = new Set(stored.entries.map((entry) => entry.entryId));
    for (const candidate of entries) {
      const entry = decodeUsageEntryV1(candidate);
      if (seen.has(entry.entryId)) continue;
      seen.add(entry.entryId);
      stored.entries.push(entry);
    }
    if (stored.entries.length > this.maximum) {
      stored.entries = stored.entries.slice(-this.maximum);
      stored.truncated = true;
    }
    await this.write(stored);
  }

  async drain(sink: UsageSinkV1): Promise<void> {
    const stored = await this.read();
    if (stored.entries.length === 0) return;
    await sink.recordEntries(stored.entries);
    const delivered = new Set(stored.entries.map((entry) => entry.entryId));
    const current = await this.read();
    await this.write({
      schemaVersion: 1,
      entries: current.entries.filter((entry) => !delivered.has(entry.entryId)),
      // A successful delivery does not repair an earlier bounded loss.
      truncated: current.truncated || stored.truncated,
    });
  }

  async state(): Promise<{ pending: number; truncated: boolean }> {
    const stored = await this.read();
    return { pending: stored.entries.length, truncated: stored.truncated };
  }
}
