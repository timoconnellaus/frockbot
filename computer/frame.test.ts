import { describe, expect, test } from "bun:test";
import {
  COMPUTER_FRAME_MAX_BYTES,
  COMPUTER_FRAME_RECORD_KEY,
  computerFrameFromCaptureV1,
  computerFrameSinkV1,
  decodeStoredComputerFrameV1,
} from "./frame.js";

function capture(bytes: Uint8Array) {
  return {
    bytes,
    mediaType: "image/png" as const,
    display: ":100",
    capturedAt: "2026-09-23T00:00:00.000Z",
  };
}

describe("the card's frame", () => {
  test("is addressed by the SHA-256 of its bytes and replaced by the next one", async () => {
    const values = new Map<string, unknown>();
    const sink = computerFrameSinkV1({
      get: <T>(key: string) => Promise.resolve(values.get(key) as T),
      put: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
    });

    const first = await computerFrameFromCaptureV1(
      capture(new Uint8Array([1])),
    );
    const second = await computerFrameFromCaptureV1(
      capture(new Uint8Array([2])),
    );
    await sink.put(first!);
    await sink.put(second!);

    expect(first!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first!.contentHash).not.toBe(second!.contentHash);
    expect([...values.keys()]).toEqual([COMPUTER_FRAME_RECORD_KEY]);
    expect(
      decodeStoredComputerFrameV1(values.get(COMPUTER_FRAME_RECORD_KEY)),
    ).toEqual(second!);
  });

  test("is not kept when the capture is larger than a Durable Object value allows", async () => {
    expect(
      await computerFrameFromCaptureV1(
        capture(new Uint8Array(COMPUTER_FRAME_MAX_BYTES + 1)),
      ),
    ).toBeUndefined();
  });

  test("refuses a stored record of any other shape", async () => {
    const frame = await computerFrameFromCaptureV1(
      capture(new Uint8Array([1])),
    );
    expect(() =>
      decodeStoredComputerFrameV1({ ...frame, path: "old.png" }),
    ).toThrow();
    expect(() =>
      decodeStoredComputerFrameV1({ ...frame, contentHash: "abc" }),
    ).toThrow();
    expect(() =>
      decodeStoredComputerFrameV1({ ...frame, bytes: [1] }),
    ).toThrow();
  });
});
