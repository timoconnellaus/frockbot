import { describe, expect, test } from "bun:test";
import { createMemoryVoiceLedgerStorageV1 } from "./ledger.js";
import {
  beginVoiceActivationV1,
  dueVoiceWorkV1,
  fenceVoiceActivationV1,
  putVoiceActiveWorkV1,
  putVoiceWorkV1,
  sealVoiceCallV1,
  voiceActiveKeyV1,
  voiceDeliveryBackoffSecondsV1,
  voicePendingKeyV1,
  voiceWorkKeyV1,
  VOICE_MAINTENANCE_CONTINUATION_SECONDS_V1,
  VOICE_PENDING_PREFIX_V1,
  VoiceMaintenanceSchedulerV1,
  type VoiceWorkRecordV1,
} from "./recovery.js";

function work(id: string, nextAt: number): VoiceWorkRecordV1 {
  return {
    schemaVersion: 1,
    kind: "transcript",
    id,
    ref: `voice:call:sealed:${id}`,
    callId: id,
    state: "pending",
    nextAt,
    attempts: 0,
  };
}

describe("voice recovery indexes", () => {
  test("a rolled-back seal leaves neither the obligation nor the cleared call", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    await storage.put("voice:call:current", {
      schemaVersion: 1,
      callId: "call-1",
    });
    const original = storage.transaction?.bind(storage);
    storage.transaction = async (run) => {
      if (!original) throw new Error("missing transaction");
      return original(async (tx) => {
        await run(tx);
        throw new Error("rollback");
      });
    };
    await expect(
      sealVoiceCallV1(storage, {
        callId: "call-1",
        startedAt: "2026-09-22T00:00:00.000Z",
        endedAt: "2026-09-22T00:01:00.000Z",
        turnSequence: 2,
        now: 1,
      }),
    ).rejects.toThrow(/rollback/);
    expect(storage.entries.has("voice:call:current")).toBe(true);
    expect(
      [...storage.entries.keys()].some((key) =>
        key.startsWith(VOICE_PENDING_PREFIX_V1),
      ),
    ).toBe(false);
    expect(storage.entries.has(voiceWorkKeyV1("transcript", "call-1"))).toBe(
      false,
    );
  });

  test("sealing twice records one transcript obligation", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    const input = {
      callId: "call-1",
      botId: "general",
      startedAt: "2026-09-22T00:00:00.000Z",
      endedAt: "2026-09-22T00:01:00.000Z",
      turnSequence: 1,
      now: 10,
    };
    await sealVoiceCallV1(storage, input);
    await sealVoiceCallV1(storage, {
      ...input,
      endedAt: "2026-09-22T00:02:00.000Z",
    });
    const pending = [...storage.entries.keys()].filter(
      (key) =>
        key.startsWith(`${VOICE_PENDING_PREFIX_V1}`) &&
        key.includes(":transcript:"),
    );
    expect(pending).toHaveLength(1);
    expect(await dueVoiceWorkV1(storage, 10)).toHaveLength(2);
  });

  test("a new activation is not abandoned by the previous one", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    await beginVoiceActivationV1(storage, "old");
    await putVoiceActiveWorkV1(storage, {
      schemaVersion: 1,
      kind: "turn",
      id: "old-turn",
      callId: "call-old",
      requestId: "req-old",
      activation: "old",
    });
    await putVoiceWorkV1(storage, {
      ...work("old-turn", 0),
      kind: "turn",
      id: "old-turn",
    });
    await putVoiceActiveWorkV1(storage, {
      schemaVersion: 1,
      kind: "turn",
      id: "new-turn",
      callId: "call-new",
      requestId: "req-new",
      activation: "new",
    });
    await putVoiceWorkV1(storage, {
      ...work("new-turn", 0),
      kind: "turn",
      id: "new-turn",
      callId: "call-new",
    });
    const fenced = await fenceVoiceActivationV1(storage, "old", "new");
    expect(fenced.fenced).toEqual(["old-turn"]);
    expect(storage.entries.has(voiceActiveKeyV1("turn", "new-turn"))).toBe(
      true,
    );
    expect(
      (await storage.get<VoiceWorkRecordV1>(voiceWorkKeyV1("turn", "new-turn")))
        ?.state,
    ).toBe("pending");
    expect(
      (await storage.get<VoiceWorkRecordV1>(voiceWorkKeyV1("turn", "old-turn")))
        ?.state,
    ).toBe("uncertain");
  });

  test("due work is bounded and ordered", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    for (let index = 0; index < 10; index += 1) {
      await putVoiceWorkV1(storage, work(`call-${index}`, index));
    }
    const due = await dueVoiceWorkV1(storage, 5, 8);
    expect(due.map((item) => item.id)).toEqual([
      "call-0",
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
    ]);
    expect(due.length).toBeLessThanOrEqual(8);
  });
});

describe("crash-safe voice scheduling", () => {
  test("an early callback waits for the obligation commit", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    const scheduled: string[] = [];
    let early: Promise<"stopped" | "continued"> | undefined;
    const scheduler = new VoiceMaintenanceSchedulerV1(async (_delay, token) => {
      scheduled.push(token);
      if (!early) {
        early = scheduler.onCallback({
          pending: async () =>
            storage.entries.has(voicePendingKeyV1(0, "transcript", "call-1")),
          drain: async () => undefined,
        });
      }
    });
    await scheduler.commit(async () => {
      await putVoiceWorkV1(storage, work("call-1", 0));
    });
    expect(await early).toBe("continued");
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
  });

  test("a crash before the write leaves a callback and no obligation", async () => {
    const storage = createMemoryVoiceLedgerStorageV1();
    const scheduler = new VoiceMaintenanceSchedulerV1(async () => undefined);
    await expect(
      scheduler.commit(async () => {
        throw new Error("crashed before the write");
      }),
    ).rejects.toThrow(/crashed before the write/);
    expect(storage.entries.size).toBe(0);
    expect(
      await scheduler.onCallback({
        pending: async () => false,
        drain: async () => {
          throw new Error("drain must not run");
        },
      }),
    ).toBe("stopped");
  });

  test("an empty queue does not arm another callback", async () => {
    let calls = 0;
    const scheduler = new VoiceMaintenanceSchedulerV1(async () => {
      calls += 1;
    });
    expect(
      await scheduler.onCallback({
        pending: async () => false,
        drain: async () => undefined,
      }),
    ).toBe("stopped");
    expect(calls).toBe(0);
  });

  test("delivery backoff grows and caps", () => {
    expect(voiceDeliveryBackoffSecondsV1(1)).toBe(2);
    expect(voiceDeliveryBackoffSecondsV1(2)).toBe(4);
    expect(voiceDeliveryBackoffSecondsV1(3)).toBe(8);
    expect(voiceDeliveryBackoffSecondsV1(20)).toBe(300);
    expect(VOICE_MAINTENANCE_CONTINUATION_SECONDS_V1).toBe(2);
  });
});
