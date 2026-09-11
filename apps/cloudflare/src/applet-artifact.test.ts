import { describe, expect, test } from "bun:test";
import { sha256HexV1, verifyAppletArtifactV1 } from "./applet-artifact.ts";

const source = 'export class Applet { health() { return "A"; } }';
const object = (text: string, etag: string) => ({
  etag,
  text: () => Promise.resolve(text),
});

describe("mismatched bytes never become code", () => {
  test("an unpinned read hashes in full and answers the etag to pin", async () => {
    const contentHash = await sha256HexV1(source);
    expect(
      await verifyAppletArtifactV1({
        contentHash,
        object: object(source, '"etag-1"'),
      }),
    ).toEqual({ source, etag: '"etag-1"', hashed: true });
  });

  test("a read that finds the pinned etag is the object that was hashed, and skips the hash", async () => {
    const contentHash = await sha256HexV1(source);
    expect(
      await verifyAppletArtifactV1({
        contentHash,
        object: object(source, '"etag-1"'),
        pinnedEtag: '"etag-1"',
      }),
    ).toEqual({ source, etag: '"etag-1"', hashed: false });
  });

  test("an object rewritten under the key has another etag, and is hashed — and refused", async () => {
    const contentHash = await sha256HexV1(source);
    await expect(
      verifyAppletArtifactV1({
        contentHash,
        object: object(`${source} // tampered`, '"etag-2"'),
        pinnedEtag: '"etag-1"',
      }),
    ).rejects.toThrow(/failed hash verification/);
    // The same rewrite with no pin at all is refused the same way.
    await expect(
      verifyAppletArtifactV1({
        contentHash,
        object: object(`${source} // tampered`, '"etag-2"'),
      }),
    ).rejects.toThrow(/failed hash verification/);
  });

  test("a rewrite that kept the bytes is re-hashed once and re-pinned", async () => {
    const contentHash = await sha256HexV1(source);
    expect(
      await verifyAppletArtifactV1({
        contentHash,
        object: object(source, '"etag-3"'),
        pinnedEtag: '"etag-1"',
      }),
    ).toEqual({ source, etag: '"etag-3"', hashed: true });
  });

  test("a missing object is unavailable, never an empty module", async () => {
    await expect(
      verifyAppletArtifactV1({ contentHash: "a".repeat(64), object: null }),
    ).rejects.toThrow(/unavailable/);
  });
});
