// The Bot half of Voice answer delivery.
//
// A Voice ask is an ordinary agent-lane Turn owned by the target Bot. Once its
// `turn/end` is durable, this projection takes the first text `send_to_user`
// from that Turn and puts it in a bounded Bot-local outbox before crossing to
// the User Durable Object. The User ledger is therefore never dependent on a
// caller or socket remaining resident while the Bot works.
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  decodeVoiceAnswerDeliveryV1,
  VOICE_ANSWER_OUTBOX_MAX_V1,
  type VoiceAnswerDeliveryV1,
} from "./shared.js";

export const VOICE_ANSWER_OUTBOX_KEY_V1 = "voice:answer-outbox:v1";

export interface VoiceAnswerSinkV1 {
  recordVoiceAnswer(delivery: VoiceAnswerDeliveryV1): Promise<void>;
}

export interface VoiceAnswerOutboxStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface StoredVoiceAnswerOutboxV1 {
  schemaVersion: 1;
  deliveries: VoiceAnswerDeliveryV1[];
  truncated: boolean;
}

function decodeOutboxV1(value: unknown): StoredVoiceAnswerOutboxV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: 1, deliveries: [], truncated: false };
  }
  const candidate = value as Partial<StoredVoiceAnswerOutboxV1>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.deliveries)) {
    return { schemaVersion: 1, deliveries: [], truncated: true };
  }
  const deliveries: VoiceAnswerDeliveryV1[] = [];
  for (const delivery of candidate.deliveries.slice(
    -VOICE_ANSWER_OUTBOX_MAX_V1,
  )) {
    try {
      deliveries.push(decodeVoiceAnswerDeliveryV1(delivery));
    } catch {
      // The authoritative run remains reconstructable. `truncated` makes an
      // invalid derived row visible instead of silently accepting it.
    }
  }
  return {
    schemaVersion: 1,
    deliveries,
    truncated:
      candidate.truncated === true ||
      candidate.deliveries.length !== deliveries.length,
  };
}

export function voiceAnswerFromSettledTurnV1(input: {
  userId: string;
  botId: string;
  runId: string;
  turn: number;
  origin?: { kind: string; messageId?: string };
  events: readonly SessionEvent[];
}): VoiceAnswerDeliveryV1 | undefined {
  if (input.origin?.kind !== "voice" || !input.origin.messageId) return;
  const ended = input.events.find(
    (event) => event.type === "turn/end" && event.turn === input.turn,
  );
  if (!ended || ended.type !== "turn/end") return;
  const sent = input.events.find(
    (event) =>
      event.type === "send/to-user" &&
      event.turn === input.turn &&
      event.payload.type === "text",
  );
  const base = {
    schemaVersion: 1 as const,
    userId: input.userId,
    askId: input.origin.messageId,
    botId: input.botId,
    runId: input.runId,
    at: sent?.timestamp ?? ended.timestamp,
  };
  return sent?.type === "send/to-user" && sent.payload.type === "text"
    ? { ...base, outcome: "answered", answer: sent.payload.text }
    : {
        ...base,
        outcome: "failed",
        reason:
          ended.outcome === "completed"
            ? "The Bot finished without a text answer."
            : "The Bot could not answer that Voice question.",
      };
}

export class VoiceAnswerOutboxV1 {
  constructor(private readonly storage: VoiceAnswerOutboxStorageV1) {}

  private async read(): Promise<StoredVoiceAnswerOutboxV1> {
    return decodeOutboxV1(
      await this.storage.get<unknown>(VOICE_ANSWER_OUTBOX_KEY_V1),
    );
  }

  private async write(outbox: StoredVoiceAnswerOutboxV1): Promise<void> {
    if (outbox.deliveries.length === 0 && !outbox.truncated) {
      await this.storage.delete(VOICE_ANSWER_OUTBOX_KEY_V1);
      return;
    }
    await this.storage.put(VOICE_ANSWER_OUTBOX_KEY_V1, outbox);
  }

  async append(delivery: VoiceAnswerDeliveryV1): Promise<void> {
    const decoded = decodeVoiceAnswerDeliveryV1(delivery);
    const stored = await this.read();
    if (
      stored.deliveries.some(
        (held) => held.askId === decoded.askId && held.runId === decoded.runId,
      )
    ) {
      return;
    }
    stored.deliveries.push(decoded);
    if (stored.deliveries.length > VOICE_ANSWER_OUTBOX_MAX_V1) {
      stored.deliveries = stored.deliveries.slice(-VOICE_ANSWER_OUTBOX_MAX_V1);
      stored.truncated = true;
    }
    await this.write(stored);
  }

  async drain(sink: VoiceAnswerSinkV1): Promise<void> {
    const stored = await this.read();
    for (const delivery of stored.deliveries) {
      await sink.recordVoiceAnswer(delivery);
      const current = await this.read();
      await this.write({
        ...current,
        deliveries: current.deliveries.filter(
          (candidate) =>
            candidate.askId !== delivery.askId ||
            candidate.runId !== delivery.runId,
        ),
      });
    }
  }

  async state(): Promise<{ pending: number; truncated: boolean }> {
    const stored = await this.read();
    return {
      pending: stored.deliveries.length,
      truncated: stored.truncated,
    };
  }
}
