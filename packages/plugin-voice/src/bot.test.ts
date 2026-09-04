import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { VoiceAnswerOutboxV1, voiceAnswerFromSettledTurnV1 } from "./bot.js";

describe("Voice Bot answer projection", () => {
  test("takes the first text send from the settled Voice Turn", () => {
    const delivery = voiceAnswerFromSettledTurnV1({
      userId: "user-1",
      botId: "research",
      runId: "agent-1",
      turn: 2,
      origin: { kind: "voice", messageId: "ask-1" },
      events: [
        {
          type: "send/to-user",
          seq: 1,
          timestamp: "2026-09-04T01:02:03.000Z",
          turn: 2,
          step: 1,
          occurrenceId: "2:1:0",
          payload: { type: "text", text: "First answer." },
        },
        {
          type: "send/to-user",
          seq: 2,
          timestamp: "2026-09-04T01:02:04.000Z",
          turn: 2,
          step: 2,
          occurrenceId: "2:2:0",
          payload: { type: "text", text: "Second answer." },
        },
        {
          type: "turn/end",
          seq: 3,
          timestamp: "2026-09-04T01:02:05.000Z",
          turn: 2,
          outcome: "completed",
        },
      ] as SessionEvent[],
    });
    expect(delivery).toMatchObject({
      outcome: "answered",
      askId: "ask-1",
      answer: "First answer.",
    });
  });

  test("keeps a delivery until the User ledger accepts it", async () => {
    const values = new Map<string, unknown>();
    const outbox = new VoiceAnswerOutboxV1({
      get: (key) => Promise.resolve(values.get(key) as never),
      put: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => Promise.resolve(values.delete(key)),
    });
    const delivery = {
      schemaVersion: 1 as const,
      outcome: "answered" as const,
      userId: "user-1",
      askId: "ask-1",
      botId: "research",
      runId: "agent-1",
      answer: "Done.",
      at: "2026-09-04T01:02:03.000Z",
    };
    await outbox.append(delivery);
    await expect(
      outbox.drain({
        recordVoiceAnswer: () => Promise.reject(new Error("away")),
      }),
    ).rejects.toThrow("away");
    expect(await outbox.state()).toMatchObject({ pending: 1 });
    await outbox.drain({ recordVoiceAnswer: () => Promise.resolve() });
    expect(await outbox.state()).toMatchObject({ pending: 0 });
  });
});
