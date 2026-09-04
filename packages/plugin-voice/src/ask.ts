import type { AgentTurnSlotReceiptV1 } from "@frockbot/plugin-flock/quota";
import type { VoiceLedgerV1 } from "./ledger.js";
import type { VoiceBotSummaryV1 } from "./tools.js";

export interface VoiceAskHostV1 {
  listBots(): Promise<readonly VoiceBotSummaryV1[]>;
  reserveAgentTurn(request: {
    schemaVersion: 1;
    userId: string;
    requesterId: string;
    runId: string;
    reservedAt: string;
  }): Promise<AgentTurnSlotReceiptV1>;
  releaseAgentTurn(request: {
    schemaVersion: 1;
    userId: string;
    requesterId: string;
    runId: string;
  }): Promise<void>;
  runAgent(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: {
      runId: string;
      sessionId: string;
      acceptedAt: string;
      text: string;
      source: { kind: "voice"; messageId: string };
    };
  }): Promise<unknown>;
  defer(task: Promise<void>): void;
}

export type VoiceAskResultV1 =
  | {
      status: "accepted";
      message: string;
      askId: string;
      runId: string;
      botId: string;
      botName: string;
    }
  | { status: "refused"; message: string };

async function digestIdV1(prefix: string, parts: readonly string[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${hex.slice(0, 32)}`;
}

function botNamed(
  bots: readonly VoiceBotSummaryV1[],
  requested: string,
): VoiceBotSummaryV1 | undefined {
  return (
    bots.find((bot) => bot.botId === requested) ??
    bots.find((bot) => bot.name.toLowerCase() === requested.toLowerCase())
  );
}

/**
 * User-authority coordinator for `ask_bot`.
 *
 * It returns after durable intent and admission scheduling, never after the
 * Bot's answer. A repeated Gemini function call derives the same ids and may
 * safely call the target again: the target Bot's run admission is the
 * idempotency fence, so a crash between this object and that fence cannot
 * become either a lost ask or a second Turn.
 */
export async function askBotFromVoiceV1(
  ledger: VoiceLedgerV1,
  host: VoiceAskHostV1,
  input: {
    userId: string;
    sessionId: string;
    callId: string;
    bot: string;
    question: string;
    at: string;
  },
): Promise<VoiceAskResultV1> {
  const target = botNamed(await host.listBots(), input.bot);
  if (!target || target.status !== "active") {
    return {
      status: "refused",
      message: `I can't ask ${input.bot} because that Bot isn't active.`,
    };
  }
  const askId = await digestIdV1("voice-ask", [
    input.userId,
    input.sessionId,
    input.callId,
  ]);
  const runId = await digestIdV1("agent", [input.userId, target.botId, askId]);
  const requesterId = `voice-${input.sessionId}`;
  const recorded = await ledger.recordAsk({
    schemaVersion: 1,
    type: "voice/ask",
    askId,
    sessionId: input.sessionId,
    botId: target.botId,
    botName: target.name,
    question: input.question,
    runId,
    askedAt: input.at,
  });
  if (recorded.status === "refused") {
    return { status: "refused", message: recorded.reason };
  }
  if (recorded.record.failed) {
    return { status: "refused", message: recorded.record.failed.reason };
  }
  const accepted = {
    status: "accepted" as const,
    message: `I've asked ${target.name}. I'll tell you when ${target.name} answers.`,
    askId,
    runId,
    botId: target.botId,
    botName: target.name,
  };
  if (recorded.record.answered) return accepted;

  const reservation = await host.reserveAgentTurn({
    schemaVersion: 1,
    userId: input.userId,
    requesterId,
    runId,
    reservedAt: input.at,
  });
  if (reservation.status === "refused") {
    const message =
      "I can't ask another Bot right now because eight agent requests are already running.";
    await ledger.recordFailed({
      schemaVersion: 1,
      type: "voice/failed",
      askId,
      botId: target.botId,
      runId,
      reason: message,
      failedAt: input.at,
    });
    return { status: "refused", message };
  }

  host.defer(
    host
      .runAgent({
        schemaVersion: 1,
        userId: input.userId,
        botId: target.botId,
        command: {
          runId,
          sessionId: `${input.userId}:${target.botId}`,
          acceptedAt: input.at,
          text: input.question,
          source: { kind: "voice", messageId: askId },
        },
      })
      .then(() => undefined)
      .catch(async (error) => {
        const message = `I couldn't get an answer from ${target.name}: ${
          error instanceof Error ? error.message : "the Bot run failed"
        }`.slice(0, 2_000);
        try {
          await ledger.recordFailed({
            schemaVersion: 1,
            type: "voice/failed",
            askId,
            botId: target.botId,
            runId,
            reason: message,
            failedAt: new Date().toISOString(),
          });
        } finally {
          await host.releaseAgentTurn({
            schemaVersion: 1,
            userId: input.userId,
            requesterId,
            runId,
          });
        }
      }),
  );
  return accepted;
}
