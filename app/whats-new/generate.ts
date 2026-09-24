/**
 * Writes `entries.generated.ts` and `media.generated.ts` from `entries/` and
 * `media/`. The Worker has no filesystem, so it imports every entry and
 * embeds every still. Both lists are alphabetical, never newest first, so
 * two pull requests that each add an entry almost always change different
 * lines; when their ids sort into the same gap, rerunning this resolves it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WHATS_NEW_MEDIA_MAX_BYTES_V1 } from "./media.ts";

const entriesDirectory = fileURLToPath(new URL("./entries", import.meta.url));
const mediaDirectory = fileURLToPath(new URL("./media", import.meta.url));
const entriesPath = fileURLToPath(
  new URL("./entries.generated.ts", import.meta.url),
);
const mediaPath = fileURLToPath(
  new URL("./media.generated.ts", import.meta.url),
);

/** The ids under `entries/`: each file is named for the entry it declares. */
export function whatsNewEntryIdsOnDiskV1(): string[] {
  return readdirSync(entriesDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -".ts".length))
    .sort();
}

export function whatsNewEntriesIndexSourceV1(ids: readonly string[]): string {
  const binding = (id: string) => `entry_${id.replaceAll("-", "_")}`;
  const imports = ids.map(
    (id) => `import ${binding(id)} from "./entries/${id}.ts";`,
  );
  const rows = ids.map((id) => `  ${binding(id)},`);
  return `/** Every entry under \`entries/\`, alphabetically. \`generate.ts\` writes it; \`entries.ts\` orders it. */\n${imports.join("\n")}\n\nexport const WHATS_NEW_ENTRY_FILES_V1 = [\n${rows.join("\n")}\n];\n`;
}

export function writeWhatsNewGeneratedFilesV1(): void {
  writeFileSync(
    entriesPath,
    whatsNewEntriesIndexSourceV1(whatsNewEntryIdsOnDiskV1()),
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
    mediaPath,
    `/** Bytes for each What’s New still, so the Worker does not need the filesystem. */\nexport const WHATS_NEW_MEDIA_V1: Readonly<Record<string, string>> = {\n${rows.join("\n")}\n};\n`,
  );
}

if (import.meta.main) {
  writeWhatsNewGeneratedFilesV1();
}
