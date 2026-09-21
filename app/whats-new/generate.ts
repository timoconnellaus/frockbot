/**
 * Writes `PREVIEW.md` and `media.generated.ts` from `entries.ts` and `media/`.
 * The Worker embeds the stills; it has no filesystem.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WHATS_NEW_MEDIA_MAX_BYTES_V1 } from "./media.ts";
import {
  WHATS_NEW_PREVIEW_PATH_V1,
  whatsNewPreviewMarkdownV1,
} from "./preview.ts";

const mediaDirectory = fileURLToPath(new URL("./media", import.meta.url));
const generatedPath = fileURLToPath(
  new URL("./media.generated.ts", import.meta.url),
);

export function writeWhatsNewGeneratedFilesV1(): void {
  writeFileSync(
    fileURLToPath(WHATS_NEW_PREVIEW_PATH_V1),
    whatsNewPreviewMarkdownV1(),
  );

  const files = readdirSync(mediaDirectory)
    .filter((name) => name.endsWith(".webp"))
    .sort();
  const rows = files.map((file) => {
    const bytes = readFileSync(join(mediaDirectory, file));
    if (bytes.byteLength > WHATS_NEW_MEDIA_MAX_BYTES_V1) {
      throw new Error(
        `${file} is ${bytes.byteLength} bytes; What’s New stills stay under ${WHATS_NEW_MEDIA_MAX_BYTES_V1}`,
      );
    }
    return `  ${JSON.stringify(file)}:\n    ${JSON.stringify(Buffer.from(bytes).toString("base64"))},`;
  });
  writeFileSync(
    generatedPath,
    `/** Bytes for each What’s New still, so the Worker does not need the filesystem. */\nexport const WHATS_NEW_MEDIA_V1: Readonly<Record<string, string>> = {\n${rows.join("\n")}\n};\n`,
  );
}

if (import.meta.main) {
  writeWhatsNewGeneratedFilesV1();
}
