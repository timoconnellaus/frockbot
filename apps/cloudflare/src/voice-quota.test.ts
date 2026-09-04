import { describe, expect, test } from "bun:test";
import {
  decodeVoiceAssistantQuotaReceiptV1,
  decodeVoiceQuotaReceiptV1,
  recordVoiceAssistantUsageV1,
  recordVoiceUsageV1,
  reserveVoiceAssistantV1,
  reserveVoiceCaptureV1,
  VOICE_ASSISTANT_MINUTES_PER_MONTH_V1,
  VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
  VOICE_MINUTES_PER_DAY_V1,
  VOICE_SECONDS_PER_DAY_V1,
  voiceQuotaDayV1,
  voiceQuotaKeyV1,
  voiceQuotaMonthV1,
  voiceSessionKeyV1,
  type VoiceQuotaStorage,
  type VoiceQuotaTransaction,
} from "./voice-quota.js";

/**
 * The narrow storage surface, in memory. `transaction` runs its callback
 * against the same map, which is what a Durable Object's does for a single
 * caller — and the bound this module enforces is a per-object one.
 */
function memoryStorage(): VoiceQuotaStorage {
  const values = new Map<string, unknown>();
  const surface: VoiceQuotaTransaction = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
      const found = new Map<string, T>();
      for (const [key, value] of values) {
        if (!key.startsWith(prefix)) continue;
        if (limit !== undefined && found.size >= limit) break;
        found.set(key, value as T);
      }
      return found;
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
  return { ...surface, transaction: (callback) => callback(surface) };
}

const DAY = "2026-09-04";

describe("the durable per-User voice budget", () => {
  test("admits a capture while the day has room", async () => {
    const storage = memoryStorage();
    expect(
      await reserveVoiceCaptureV1(storage, { day: DAY, sessionId: "one" }),
    ).toMatchObject({ status: "reserved", usedSeconds: 0 });
  });

  test("charges only what a session has not already been charged for", async () => {
    const storage = memoryStorage();
    await reserveVoiceCaptureV1(storage, { day: DAY, sessionId: "one" });
    expect(
      await recordVoiceUsageV1(storage, {
        day: DAY,
        sessionId: "one",
        seconds: 30,
      }),
    ).toMatchObject({ usedSeconds: 30 });
    // The same report again — a retried close, an object that came back — is
    // the same total, not a second thirty seconds.
    expect(
      await recordVoiceUsageV1(storage, {
        day: DAY,
        sessionId: "one",
        seconds: 30,
      }),
    ).toMatchObject({ usedSeconds: 30 });
    expect(
      await recordVoiceUsageV1(storage, {
        day: DAY,
        sessionId: "one",
        seconds: 45,
      }),
    ).toMatchObject({ usedSeconds: 45 });
  });

  test("adds up across sessions and refuses once the day is spent", async () => {
    const storage = memoryStorage();
    for (let index = 0; index < VOICE_MINUTES_PER_DAY_V1; index += 1) {
      const sessionId = `s-${index}`;
      expect(
        await reserveVoiceCaptureV1(storage, { day: DAY, sessionId }),
      ).toMatchObject({ status: "reserved" });
      await recordVoiceUsageV1(storage, { day: DAY, sessionId, seconds: 60 });
    }
    const refused = await reserveVoiceCaptureV1(storage, {
      day: DAY,
      sessionId: "one-too-many",
    });
    expect(refused.status).toBe("refused");
    expect(refused.usedSeconds).toBe(VOICE_SECONDS_PER_DAY_V1);
    // Plain English, and it says when the microphone comes back.
    expect(refused.reason).toContain(String(VOICE_MINUTES_PER_DAY_V1));
    expect(refused.reason).toContain("tomorrow");
  });

  test("a new day starts clear, and sweeps the old one's keys", async () => {
    const storage = memoryStorage();
    await reserveVoiceCaptureV1(storage, { day: DAY, sessionId: "one" });
    await recordVoiceUsageV1(storage, {
      day: DAY,
      sessionId: "one",
      seconds: VOICE_SECONDS_PER_DAY_V1,
    });
    expect(
      await reserveVoiceCaptureV1(storage, { day: DAY, sessionId: "two" }),
    ).toMatchObject({ status: "refused" });
    const tomorrow = "2026-09-05";
    expect(
      await reserveVoiceCaptureV1(storage, {
        day: tomorrow,
        sessionId: "three",
      }),
    ).toMatchObject({ status: "reserved", usedSeconds: 0 });
    expect(await storage.get(voiceQuotaKeyV1(DAY))).toBeUndefined();
    expect(await storage.get(voiceSessionKeyV1(DAY, "one"))).toBeUndefined();
  });

  test("a report that goes backwards never gives seconds back", async () => {
    const storage = memoryStorage();
    await reserveVoiceCaptureV1(storage, { day: DAY, sessionId: "one" });
    await recordVoiceUsageV1(storage, {
      day: DAY,
      sessionId: "one",
      seconds: 40,
    });
    expect(
      await recordVoiceUsageV1(storage, {
        day: DAY,
        sessionId: "one",
        seconds: 5,
      }),
    ).toMatchObject({ usedSeconds: 40 });
  });

  test("refuses a malformed day or session id rather than writing a stray key", () => {
    expect(() => voiceQuotaKeyV1("4 September")).toThrow();
    expect(() => voiceSessionKeyV1(DAY, "one:two")).toThrow();
    expect(voiceQuotaDayV1(new Date("2026-09-04T23:59:59.000Z"))).toBe(DAY);
  });

  test("the receipt survives the RPC boundary it crosses", async () => {
    const storage = memoryStorage();
    const receipt = await reserveVoiceCaptureV1(storage, {
      day: DAY,
      sessionId: "one",
    });
    expect(
      decodeVoiceQuotaReceiptV1(JSON.parse(JSON.stringify(receipt))),
    ).toEqual(receipt);
    expect(() => decodeVoiceQuotaReceiptV1({ schemaVersion: 2 })).toThrow();
    expect(() =>
      decodeVoiceQuotaReceiptV1({ ...receipt, status: "maybe" }),
    ).toThrow();
  });
});

describe("the durable monthly Voice assistant budget", () => {
  const MONTH = "2026-09";

  test("charges idempotent session totals and refuses a spent month", async () => {
    const storage = memoryStorage();
    await reserveVoiceAssistantV1(storage, { month: MONTH, sessionId: "one" });
    await recordVoiceAssistantUsageV1(storage, {
      month: MONTH,
      sessionId: "one",
      seconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    });
    await recordVoiceAssistantUsageV1(storage, {
      month: MONTH,
      sessionId: "one",
      seconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    });
    const refused = await reserveVoiceAssistantV1(storage, {
      month: MONTH,
      sessionId: "two",
    });
    expect(refused).toMatchObject({
      status: "refused",
      usedSeconds: VOICE_ASSISTANT_SECONDS_PER_MONTH_V1,
    });
    expect(refused.reason).toContain(
      String(VOICE_ASSISTANT_MINUTES_PER_MONTH_V1),
    );
    expect(refused.reason).toContain("next month");
    expect(decodeVoiceAssistantQuotaReceiptV1(refused)).toEqual(refused);
  });

  test("uses a UTC month key", () => {
    expect(voiceQuotaMonthV1(new Date("2026-09-30T23:59:59.000Z"))).toBe(MONTH);
  });
});
