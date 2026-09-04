import { describe, expect, test } from "bun:test";
import { askBotFromVoiceV1, type VoiceAskHostV1 } from "./ask.js";
import { VoiceLedgerV1, type VoiceLedgerStorageV1 } from "./ledger.js";

function memoryStorage(): VoiceLedgerStorageV1 {
  const values = new Map<string, unknown>();
  const surface = {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key, value as T]),
      ),
  };
  return { ...surface, transaction: (callback) => callback(surface) };
}

describe("Voice ask coordinator", () => {
  test("a replay reaches one idempotent target Turn", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    const admitted = new Set<string>();
    let targetTurns = 0;
    const deferred: Promise<void>[] = [];
    const host: VoiceAskHostV1 = {
      listBots: () =>
        Promise.resolve([
          { botId: "research", name: "Research", status: "active" },
        ]),
      reserveAgentTurn: (request) =>
        Promise.resolve({
          schemaVersion: 1,
          status: "reserved",
          requesterId: request.requesterId,
          runId: request.runId,
          held: 1,
          limit: 8,
        }),
      releaseAgentTurn: () => Promise.resolve(),
      runAgent: async (request) => {
        if (!admitted.has(request.command.runId)) {
          admitted.add(request.command.runId);
          targetTurns += 1;
        }
      },
      defer(task) {
        deferred.push(task);
      },
    };
    const input = {
      userId: "user-1",
      sessionId: "voice-1",
      callId: "call-1",
      bot: "Research",
      question: "What changed?",
      at: "2026-09-04T01:02:03.000Z",
    };

    const first = await askBotFromVoiceV1(ledger, host, input);
    const replay = await askBotFromVoiceV1(ledger, host, input);
    await Promise.all(deferred);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "accepted",
      message: "I've asked Research. I'll tell you when Research answers.",
    });
    expect(targetTurns).toBe(1);
  });

  test("refuses a second outstanding ask to the same Bot and session", async () => {
    const ledger = new VoiceLedgerV1(memoryStorage());
    const deferred: Promise<void>[] = [];
    const host: VoiceAskHostV1 = {
      listBots: () =>
        Promise.resolve([
          { botId: "research", name: "Research", status: "active" },
        ]),
      reserveAgentTurn: (request) =>
        Promise.resolve({
          schemaVersion: 1,
          status: "reserved",
          requesterId: request.requesterId,
          runId: request.runId,
          held: 1,
          limit: 8,
        }),
      releaseAgentTurn: () => Promise.resolve(),
      runAgent: () => new Promise(() => {}),
      defer(task) {
        deferred.push(task);
      },
    };
    await askBotFromVoiceV1(ledger, host, {
      userId: "user-1",
      sessionId: "voice-1",
      callId: "call-1",
      bot: "research",
      question: "First?",
      at: "2026-09-04T01:02:03.000Z",
    });

    await expect(
      askBotFromVoiceV1(ledger, host, {
        userId: "user-1",
        sessionId: "voice-1",
        callId: "call-2",
        bot: "research",
        question: "Second?",
        at: "2026-09-04T01:02:04.000Z",
      }),
    ).resolves.toEqual({
      status: "refused",
      message:
        "Research is already answering a Voice question from this session.",
    });
  });
});
