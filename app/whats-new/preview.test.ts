import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WHATS_NEW_PREVIEW_PATH_V1,
  whatsNewPreviewMarkdownV1,
} from "./preview.ts";

describe("What’s New preview", () => {
  test("PREVIEW.md is the generated review surface, with the screenshot linked", () => {
    const expected = whatsNewPreviewMarkdownV1();
    const onDisk = readFileSync(
      fileURLToPath(WHATS_NEW_PREVIEW_PATH_V1),
      "utf8",
    );
    expect(onDisk).toBe(expected);
    expect(expected).toContain(
      "![The What’s New page, with this feature as its first entry.](media/whats-new.webp)",
    );
    expect(expected).toContain("What’s New in the app");
  });
});
