import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";
import {
  whatsNewEntriesIndexSourceV1,
  writeWhatsNewGeneratedFilesV1,
} from "./generate.ts";

const generated = (name: string) =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));

describe("What’s New generate", () => {
  test("the entry index and the embedded stills are what generate would write", () => {
    const entries = readFileSync(generated("entries.generated.ts"), "utf8");
    const media = readFileSync(generated("media.generated.ts"), "utf8");
    writeWhatsNewGeneratedFilesV1();
    expect(readFileSync(generated("entries.generated.ts"), "utf8")).toBe(
      entries,
    );
    expect(readFileSync(generated("media.generated.ts"), "utf8")).toBe(media);
  });

  test("each entry file declares the id it is named for", async () => {
    for (const entry of WHATS_NEW_ENTRIES_V1) {
      const file = await import(`./entries/${entry.id}.ts`);
      expect(file.default.id).toBe(entry.id);
    }
  });

  test("the index is alphabetical, so two new entries land on different lines", () => {
    const source = whatsNewEntriesIndexSourceV1(["zebra", "apple-pie"].sort());
    expect(source.indexOf("entry_apple_pie,")).toBeLessThan(
      source.indexOf("entry_zebra,"),
    );
    expect(source).toContain(
      'import entry_apple_pie from "./entries/apple-pie.ts";',
    );
  });
});
