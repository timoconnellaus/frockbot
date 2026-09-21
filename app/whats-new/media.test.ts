import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import { WHATS_NEW_MEDIA_V1 } from "./media.generated.ts";
import {
  WHATS_NEW_MEDIA_MAX_BYTES_V1,
  whatsNewImageNameV1,
  whatsNewImageResponseV1,
  whatsNewMediaBytesV1,
  whatsNewMediaFileV1,
} from "./media.ts";

const mediaDirectory = fileURLToPath(new URL("./media", import.meta.url));

describe("What’s New media", () => {
  test("only a WebP under /whats-new/ is a public image path", () => {
    expect(whatsNewImageNameV1("/whats-new/whats-new.webp")).toBe(
      "whats-new.webp",
    );
    expect(whatsNewImageNameV1("/whats-new/../secret.webp")).toBeUndefined();
    expect(whatsNewImageNameV1("/whats-new/whats-new.png")).toBeUndefined();
    expect(whatsNewImageNameV1("/favicon.ico")).toBeUndefined();
    expect(whatsNewMediaFileV1("whats-new.webp")).toBe("whats-new.webp");
    expect(whatsNewMediaFileV1("../x.webp")).toBeUndefined();
  });

  test("serves each declared still as an immutable WebP", async () => {
    for (const entry of WHATS_NEW_ENTRIES_V1) {
      if (!entry.image) continue;
      const bytes = whatsNewMediaBytesV1(entry.image.file);
      expect(bytes).toBeDefined();
      expect(bytes!.byteLength).toBeLessThanOrEqual(
        WHATS_NEW_MEDIA_MAX_BYTES_V1,
      );
      expect(bytes!.subarray(0, 4)).toEqual(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
      );
      const response = whatsNewImageResponseV1(
        `/whats-new/${entry.image.file}`,
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toBe("image/webp");
      expect(response?.headers.get("cache-control")).toContain("immutable");
      expect(Buffer.from(await response!.arrayBuffer())).toEqual(
        Buffer.from(bytes!),
      );
    }
  });

  test("the bundled stills are exactly the WebP files on disk", () => {
    const files = readdirSync(mediaDirectory)
      .filter((name) => name.endsWith(".webp"))
      .sort();
    expect(Object.keys(WHATS_NEW_MEDIA_V1).sort()).toEqual(files);
    for (const file of files) {
      expect(
        Buffer.from(whatsNewMediaBytesV1(file) ?? []).equals(
          readFileSync(join(mediaDirectory, file)),
        ),
      ).toBe(true);
    }
  });

  test("a missing still is 404, not an empty picture", async () => {
    const response = whatsNewImageResponseV1("/whats-new/missing.webp");
    expect(response?.status).toBe(404);
  });
});
