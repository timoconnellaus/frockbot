import { describe, expect, test } from "bun:test";
import {
  decodeVoiceEndedReceiptV1,
  decodeVoiceResumptionRecordV1,
  offerVoiceResumptionV1,
  voiceMemoryIdentityV1,
  voiceResumptionKeyV1,
  type VoiceResumptionRecordV1,
} from "./resumption.js";

const record: VoiceResumptionRecordV1 = {
  schemaVersion: 1,
  callId: "call-1",
  botId: "bot-1",
  model: "models/gemini-3.8-live",
  fingerprint: "abc",
  handle: "h-1",
  resumable: true,
  updatedAt: "2026-09-22T12:00:00.000Z",
  lastSettledTurnSequence: 3,
};

describe("voice resumption", () => {
  test("offers a handle only for matching call, setup and settled effects", () => {
    expect(
      offerVoiceResumptionV1({
        record,
        callId: "call-1",
        botId: "bot-1",
        model: "models/gemini-3.8-live",
        fingerprint: "abc",
        uncertainEffects: false,
      }),
    ).toEqual({ status: "offer", handle: "h-1" });
  });

  test("a resumable:false update is not an offer, even with a handle", () => {
    expect(
      offerVoiceResumptionV1({
        record: { ...record, resumable: false },
        callId: "call-1",
        botId: "bot-1",
        model: "models/gemini-3.8-live",
        fingerprint: "abc",
        uncertainEffects: false,
      }),
    ).toEqual({ status: "fresh", reason: "not-resumable" });
  });

  test("uncertain effects and a setup mismatch discard the handle", () => {
    expect(
      offerVoiceResumptionV1({
        record,
        callId: "call-1",
        botId: "bot-1",
        model: "models/gemini-3.8-live",
        fingerprint: "abc",
        uncertainEffects: true,
      }),
    ).toEqual({ status: "fresh", reason: "uncertain" });
    expect(
      offerVoiceResumptionV1({
        record,
        callId: "call-1",
        botId: "bot-1",
        model: "models/gemini-3.8-live",
        fingerprint: "other",
        uncertainEffects: false,
      }),
    ).toEqual({ status: "fresh", reason: "fingerprint" });
  });

  test("decodes a record and an ended receipt, and names the key", () => {
    expect(voiceResumptionKeyV1("call-1")).toBe("voice:resumption:call-1");
    expect(decodeVoiceResumptionRecordV1(record)).toEqual(record);
    expect(
      decodeVoiceResumptionRecordV1({ ...record, schemaVersion: 2 }),
    ).toBeUndefined();
    expect(
      decodeVoiceEndedReceiptV1({
        schemaVersion: 1,
        callId: "call-1",
        deviceKey: "phone",
        endedAt: "2026-09-22T12:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: 1,
      callId: "call-1",
      deviceKey: "phone",
      endedAt: "2026-09-22T12:00:00.000Z",
    });
  });

  test("memory identity is durable and forgotten ids, sorted", () => {
    expect(
      voiceMemoryIdentityV1({
        durableIds: ["b", "a"],
        forgottenIds: ["z"],
      }),
    ).toBe("a,b|z");
  });
});
