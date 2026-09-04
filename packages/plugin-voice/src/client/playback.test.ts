import { describe, expect, test } from "bun:test";
import { pcm16LeToFloat32V1 } from "./playback.js";

describe("Voice PCM playback", () => {
  test("decodes little-endian signed PCM16 into browser samples", () => {
    const pcm = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
    expect([...pcm16LeToFloat32V1(pcm.buffer)]).toEqual([
      -1,
      0,
      32_767 / 32_768,
    ]);
  });
});
