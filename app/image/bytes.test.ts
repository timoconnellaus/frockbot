import { describe, expect, test } from "bun:test";
import { decodeImageDimensionsV1 } from "./bytes.ts";
import { fakePngBytesV1 } from "./testing.ts";

/** A minimal JPEG: SOI, an APP0 segment, then an SOF0 frame header. */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0);
  // APP0, length 4, two payload bytes.
  bytes.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2);
  // SOF0, length 11, precision 8, then height and width.
  bytes.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 8);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

describe("identifying image bytes", () => {
  test("reads a PNG's IHDR", () => {
    expect(decodeImageDimensionsV1(fakePngBytesV1(1024, 512))).toEqual({
      mimeType: "image/png",
      width: 1024,
      height: 512,
    });
  });

  test("reads a JPEG's frame header past an APP0 segment", () => {
    expect(decodeImageDimensionsV1(jpegBytes(512, 768))).toEqual({
      mimeType: "image/jpeg",
      width: 512,
      height: 768,
    });
  });

  test("refuses anything it cannot identify", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new TextEncoder().encode("<svg/>"),
      // A PNG signature whose first chunk is not IHDR.
      (() => {
        const forged = fakePngBytesV1(16, 16);
        forged[12] = 0x74;
        return forged;
      })(),
      // A PNG whose IHDR claims a zero dimension.
      fakePngBytesV1(0, 16),
    ]) {
      expect(decodeImageDimensionsV1(bytes)).toBeUndefined();
    }
  });
});
