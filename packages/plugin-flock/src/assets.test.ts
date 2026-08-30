import { describe, expect, test } from "bun:test";
import { CryptoHasher } from "bun";
import manifest from "../assets/manifest.json" with { type: "json" };

describe("production sheep assets", () => {
  test("contains the approved bounded collection with exact hashes", async () => {
    expect(manifest.assets).toHaveLength(50);
    expect(
      manifest.assets.filter((item) => item.kind === "background"),
    ).toHaveLength(6);
    expect(
      manifest.assets.filter((item) => item.kind === "upper"),
    ).toHaveLength(23);
    expect(
      manifest.assets.filter((item) => item.kind === "middle"),
    ).toHaveLength(13);
    expect(
      manifest.assets.filter((item) => item.kind === "lower"),
    ).toHaveLength(7);
    for (const asset of manifest.assets) {
      expect([asset.width, asset.height]).toEqual([256, 256]);
      const bytes = await Bun.file(
        new URL(`../assets/${asset.file}`, import.meta.url),
      ).arrayBuffer();
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
      expect(new CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
        asset.sha256,
      );
    }
  });
});
