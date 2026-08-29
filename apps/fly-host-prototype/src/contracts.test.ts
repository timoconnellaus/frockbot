import { describe, expect, test } from "bun:test";
import {
  decodeSmokeRequest,
  encodeSmokeResponse,
} from "../container/contracts.ts";

describe("Fly host v1 DTO", () => {
  test("decodes the versioned public request", () => {
    expect(
      decodeSmokeRequest({
        version: 1,
        effectId: "effect-123",
        botId: "bot-123",
        credentialRef: "sprites:prototype",
        probe: "hello",
      }),
    ).toEqual({
      version: 1,
      effectId: "effect-123",
      botId: "bot-123",
      credentialRef: "sprites:prototype",
      probe: "hello",
    });
  });

  test("rejects malformed and unknown-version requests", () => {
    expect(() => decodeSmokeRequest({ version: 2 })).toThrow(
      "Invalid Fly host smoke request",
    );
    expect(() =>
      decodeSmokeRequest({
        version: 1,
        effectId: "",
        botId: "bot-123",
        credentialRef: "sprites:prototype",
        probe: "hello",
      }),
    ).toThrow("Invalid Fly host smoke request");
  });

  test("returns only normalized capability evidence", () => {
    expect(
      encodeSmokeResponse({
        effectId: "effect-123",
        stream: "hello",
        file: "hello",
        cancellationObserved: true,
        reconstructionObserved: true,
      }),
    ).toEqual({
      version: 1,
      effectId: "effect-123",
      capabilities: {
        streaming: true,
        files: true,
        cancellation: true,
        reconstruction: true,
      },
      evidence: {
        stream: "hello",
        file: "hello",
      },
    });
  });
});
