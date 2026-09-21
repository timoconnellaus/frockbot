import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeWhatsNewGeneratedFilesV1 } from "./generate.ts";
import { WHATS_NEW_PREVIEW_PATH_V1 } from "./preview.ts";

const generatedPath = fileURLToPath(
  new URL("./media.generated.ts", import.meta.url),
);

describe("What’s New generate", () => {
  test("PREVIEW.md and the embedded stills are what generate would write", () => {
    const preview = readFileSync(
      fileURLToPath(WHATS_NEW_PREVIEW_PATH_V1),
      "utf8",
    );
    const media = readFileSync(generatedPath, "utf8");
    writeWhatsNewGeneratedFilesV1();
    expect(readFileSync(fileURLToPath(WHATS_NEW_PREVIEW_PATH_V1), "utf8")).toBe(
      preview,
    );
    expect(readFileSync(generatedPath, "utf8")).toBe(media);
  });
});
