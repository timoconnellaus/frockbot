import { describe, expect, test } from "bun:test";
import { VoiceLedgerV1, type VoiceLedgerStorageV1 } from "./ledger.js";

function memoryStorage(): VoiceLedgerStorageV1 {
  const values = new Map<string, unknown>();
  const surface = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
      return new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([key, value]) => [key, value as T]),
      );
    },
  };
  return { ...surface, transaction: (callback) => callback(surface) };
}

const AT = "2026-09-04T01:02:03.000Z";

describe("VoiceLedgerV1", () => {
  test("records voice/ask, voice/answered, and voice/briefed in order", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    await ledger.recordAsk({
      schemaVersion: 1,
      type: "voice/ask",
      askId: "ask-1",
      sessionId: "session-1",
      botId: "research",
      botName: "Research",
      question: "What changed?",
      runId: "agent-1",
      askedAt: AT,
    });
    await ledger.recordAnswered({
      schemaVersion: 1,
      type: "voice/answered",
      askId: "ask-1",
      botId: "research",
      runId: "agent-1",
      answer: "The release landed.",
      answeredAt: "2026-09-04T01:03:03.000Z",
    });

    expect((await ledger.view()).pendingAnswers).toEqual([
      expect.objectContaining({
        answerId: "ask-1",
        question: "What changed?",
        answer: "The release landed.",
      }),
    ]);
    expect(
      await ledger.markBriefed({
        askIds: ["ask-1", "ask-1"],
        sessionId: "session-2",
        at: "2026-09-04T01:04:03.000Z",
      }),
    ).toBe(1);
    expect((await ledger.view()).pendingAnswers).toEqual([]);
    expect(await ledger.readAsk("ask-1")).toEqual(
      expect.objectContaining({
        ask: expect.objectContaining({ type: "voice/ask" }),
        answered: expect.objectContaining({ type: "voice/answered" }),
        briefed: expect.objectContaining({
          type: "voice/briefed",
          sessionId: "session-2",
        }),
      }),
    );
  });

  test("keeps an answer pending when Voice is off", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    await ledger.start({ sessionId: "session-1", deviceId: "phone", at: AT });
    await ledger.end({
      sessionId: "session-1",
      at: "2026-09-04T01:02:04.000Z",
      reason: "stopped",
      seconds: 1,
    });
    await ledger.recordAsk({
      schemaVersion: 1,
      type: "voice/ask",
      askId: "ask-offline",
      sessionId: "session-1",
      botId: "research",
      botName: "Research",
      question: "Are you done?",
      runId: "agent-offline",
      askedAt: AT,
    });
    await ledger.recordAnswered({
      schemaVersion: 1,
      type: "voice/answered",
      askId: "ask-offline",
      botId: "research",
      runId: "agent-offline",
      answer: "Yes.",
      answeredAt: "2026-09-04T01:03:03.000Z",
    });

    const view = await ledger.view();
    expect(view.state.enabled).toBe(false);
    expect(view.pendingAnswers).toEqual([
      expect.objectContaining({ answerId: "ask-offline", answer: "Yes." }),
    ]);
    expect((await ledger.readAsk("ask-offline"))?.briefed).toBeUndefined();
  });

  test("counts unanswered asks against the pending-answer bound", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    for (let index = 0; index < 32; index += 1) {
      await expect(
        ledger.recordAsk({
          schemaVersion: 1,
          type: "voice/ask",
          askId: `ask-${index}`,
          sessionId: `session-${index}`,
          botId: "research",
          botName: "Research",
          question: "What changed?",
          runId: `agent-${index}`,
          askedAt: AT,
        }),
      ).resolves.toMatchObject({ status: "recorded" });
    }

    await expect(
      ledger.recordAsk({
        schemaVersion: 1,
        type: "voice/ask",
        askId: "ask-over-cap",
        sessionId: "session-over-cap",
        botId: "research",
        botName: "Research",
        question: "One more?",
        runId: "agent-over-cap",
        askedAt: AT,
      }),
    ).resolves.toEqual({
      status: "refused",
      reason: "Voice already has 32 Bot answers waiting or on the way.",
    });
  });

  test("the newest device wins and the previous session ends durably", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    await ledger.start({ sessionId: "first", deviceId: "phone", at: AT });
    const next = await ledger.start({
      sessionId: "second",
      deviceId: "laptop",
      at: "2026-09-04T01:03:03.000Z",
    });
    expect(next.replacedSessionId).toBe("first");
    const view = await ledger.view();
    expect(view.state).toMatchObject({
      enabled: true,
      activeSessionId: "second",
      activeDeviceId: "laptop",
    });
    expect(
      view.sessions.find((session) => session.sessionId === "first"),
    ).toMatchObject({
      endedReason: "replaced",
    });
  });

  test("transcript and tool writes are idempotent and never contain audio", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    await ledger.start({ sessionId: "one", deviceId: "phone", at: AT });
    const transcript = {
      schemaVersion: 1 as const,
      id: "utterance-1",
      speaker: "user" as const,
      text: "What is happening?",
      at: AT,
    };
    await ledger.appendTranscript("one", transcript);
    await ledger.appendTranscript("one", transcript);
    await ledger.appendToolCall("one", {
      schemaVersion: 1,
      id: "call-1",
      name: "list_bots",
      label: "Checked your Bots",
      at: AT,
    });
    const session = (await ledger.view()).sessions[0]!;
    expect(session.transcript).toEqual([transcript]);
    expect(session.toolCalls).toHaveLength(1);
    expect(JSON.stringify(session)).not.toContain("audio");
  });

  test("an old device cannot turn the replacement session off", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    await ledger.start({ sessionId: "first", deviceId: "phone", at: AT });
    await ledger.start({
      sessionId: "second",
      deviceId: "laptop",
      at: "2026-09-04T01:03:03.000Z",
    });
    const state = await ledger.end({
      sessionId: "first",
      at: "2026-09-04T01:04:03.000Z",
      reason: "stopped",
      seconds: 60,
    });
    expect(state.activeSessionId).toBe("second");
    expect(state.enabled).toBe(true);
  });

  test("bounds retained sessions and pending answers", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    for (let index = 0; index < 40; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await ledger.start({
        sessionId: `session-${suffix}`,
        deviceId: "phone",
        at: `2026-09-04T01:${suffix}:00.000Z`,
      });
      await ledger.recordPendingAnswer({
        schemaVersion: 1,
        answerId: `answer-${suffix}`,
        botId: "research",
        botName: "Research",
        question: "What changed?",
        answer: `Answer ${suffix}`,
        answeredAt: `2026-09-04T01:${suffix}:30.000Z`,
      });
    }

    const view = await ledger.view();
    expect(view.sessions).toHaveLength(24);
    expect(view.sessions.at(-1)?.sessionId).toBe("session-16");
    expect(view.pendingAnswers).toHaveLength(32);
    expect(view.pendingAnswers[0]?.answerId).toBe("answer-08");
  });
});
