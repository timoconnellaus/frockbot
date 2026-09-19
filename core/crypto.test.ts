import { describe, expect, test } from "bun:test";
import {
  base64urlDecodeV1,
  base64urlEncodeV1,
  bytesToHexV1,
  constantTimeEqualsV1,
  fnv1a32Utf8V1,
  sha256HexBytesV1,
  sha256HexTextV1,
} from "./crypto.js";

describe("core crypto primitives", () => {
  test("hashes UTF-8 text and raw bytes with known vectors", async () => {
    expect(await sha256HexTextV1("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256HexTextV1("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256HexTextV1("Hello, 世界 🌍")).toBe(
      "6254dedd9a9c1af06bb5dbbba088665e74800984f0f4786d245766e3f341aa3f",
    );
    expect(await sha256HexBytesV1(new Uint8Array([0, 1, 2, 255]))).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
    expect(await sha256HexBytesV1(new TextEncoder().encode("abc"))).toBe(
      await sha256HexTextV1("abc"),
    );
  });

  test("renders bytes as lower-case hexadecimal", () => {
    expect(bytesToHexV1(new Uint8Array([0, 1, 15, 16, 255]))).toBe(
      "00010f10ff",
    );
    expect(bytesToHexV1(new Uint8Array().buffer)).toBe("");
  });

  test("round-trips canonical base64url without padding", () => {
    const vectors = [
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([0, 255, 16, 128]),
      new TextEncoder().encode("Hello, 世界 🌍"),
    ];
    for (const bytes of vectors) {
      const encoded = base64urlEncodeV1(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(base64urlDecodeV1(encoded)).toEqual(bytes);
    }
  });

  test("refuses malformed and non-canonical base64url", () => {
    for (const value of [
      "=",
      "AA=",
      "AA==",
      "A",
      "A===",
      "A+B",
      "A/B",
      "AA\n",
      "AB", // non-zero trailing bits; canonical spelling is AA
    ]) {
      expect(() => base64urlDecodeV1(value)).toThrow("invalid base64url");
    }
    expect(base64urlDecodeV1("")).toEqual(new Uint8Array());
  });

  test("compares UTF-8 strings, including Unicode and unequal lengths", () => {
    expect(constantTimeEqualsV1("same", "same")).toBe(true);
    expect(constantTimeEqualsV1("same", "different")).toBe(false);
    expect(constantTimeEqualsV1("世界", "世界")).toBe(true);
    expect(constantTimeEqualsV1("世界", "世界 ")).toBe(false);
    expect(constantTimeEqualsV1("", "")).toBe(true);
    expect(constantTimeEqualsV1("", "\0")).toBe(false);
  });

  test("matches stable UTF-8 FNV-1a vectors", () => {
    expect(fnv1a32Utf8V1("")).toBe(0x811c9dc5);
    expect(fnv1a32Utf8V1("a")).toBe(0xe40c292c);
    expect(fnv1a32Utf8V1("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32Utf8V1("世界")).toBe(0x40d651bf);
    expect(fnv1a32Utf8V1("Hello, 世界 🌍")).toBe(0xbaf0183d);
  });
});
