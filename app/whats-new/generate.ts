/**
 * Writes `PREVIEW.md` and `media.generated.ts` from `entries.ts` and `media/`.
 * The Worker embeds the stills; it has no filesystem.
 *
 * Tag dates are written separately: a production tag appears after the commit,
 * and the generate check cannot require a live scan.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProductionReleaseTagV1,
  whatsNewEntryIdsInSourceV1,
  whatsNewPublishedAtByIdV1,
} from "./dates.ts";
import { WHATS_NEW_MEDIA_MAX_BYTES_V1 } from "./media.ts";
import {
  WHATS_NEW_PREVIEW_PATH_V1,
  whatsNewPreviewMarkdownV1,
} from "./preview.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mediaDirectory = fileURLToPath(new URL("./media", import.meta.url));
const generatedPath = fileURLToPath(
  new URL("./media.generated.ts", import.meta.url),
);
const datesGeneratedPath = fileURLToPath(
  new URL("./dates.generated.ts", import.meta.url),
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

function gitV1(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

function readWhatsNewTagCatalogV1(): {
  tagsById: Record<string, string[]>;
  tagDates: Record<string, string>;
} {
  const tagsById: Record<string, string[]> = {};
  const tagDates: Record<string, string> = {};
  for (const tag of gitV1("tag", "--list", "v*").split("\n")) {
    if (!isProductionReleaseTagV1(tag)) continue;
    const instant = gitV1("log", "-1", "--format=%cI", tag);
    if (!instant) continue;
    tagDates[tag] = instant;
    const source = gitV1("show", `${tag}:app/whats-new/entries.ts`);
    for (const id of whatsNewEntryIdsInSourceV1(source)) {
      (tagsById[id] ??= []).push(tag);
    }
  }
  return { tagsById, tagDates };
}

export function writeWhatsNewDatesGeneratedV1(): void {
  const { tagsById, tagDates } = readWhatsNewTagCatalogV1();
  const published = whatsNewPublishedAtByIdV1(tagsById, tagDates);
  const rows = Object.keys(published)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(published[id])},`);
  writeFileSync(
    datesGeneratedPath,
    `/** UTC calendar day the first production tag shipped each What’s New id. */\nexport const WHATS_NEW_PUBLISHED_AT_V1: Readonly<Record<string, string>> = {\n${rows.join("\n")}\n};\n`,
  );
}

if (import.meta.main) {
  writeWhatsNewGeneratedFilesV1();
  writeWhatsNewDatesGeneratedV1();
}
