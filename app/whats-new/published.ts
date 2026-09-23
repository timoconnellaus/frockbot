/**
 * Writes `published.generated.ts`: the UTC day each What’s New id first
 * shipped, read from the production tags in this checkout. The tag deploy
 * runs it on a full clone just before it bundles the Worker. The committed
 * file stays empty, so everywhere else every entry says “New”.
 *
 * An id ships with the earliest production tag whose `entries.ts` declares
 * it. Tags are cut through the API as lightweight refs, so the only date one
 * carries is its commit’s.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  earliestProductionTagDateV1,
  isProductionReleaseTagV1,
} from "./dates.ts";
import { WHATS_NEW_ENTRIES_V1 } from "./entries.ts";

const ENTRIES_PATH_V1 = "app/whats-new/entries.ts";
const ENTRY_ID_LINE_V1 = /^\s+id: "([a-z0-9][a-z0-9-]{0,63})",$/gm;

const publishedPath = fileURLToPath(
  new URL("./published.generated.ts", import.meta.url),
);
const here = fileURLToPath(new URL(".", import.meta.url));

/** The ids one revision of `entries.ts` declares. */
export function whatsNewIdsInSourceV1(source: string): string[] {
  return Array.from(source.matchAll(ENTRY_ID_LINE_V1), (match) => match[1]!);
}

/**
 * The day each of [ids] first shipped. [tagDates] is every tag’s instant;
 * [idsAt] reads the ids a tag’s `entries.ts` declares. An id no production
 * tag declares yet is left out.
 */
export function whatsNewPublishedDaysV1(
  ids: readonly string[],
  tagDates: Readonly<Record<string, string>>,
  idsAt: (tag: string) => readonly string[],
): Record<string, string> {
  const wanted = new Set(ids);
  const tagsById = new Map<string, string[]>();
  for (const tag of Object.keys(tagDates)) {
    if (!isProductionReleaseTagV1(tag)) continue;
    for (const id of idsAt(tag)) {
      if (wanted.has(id)) tagsById.set(id, [...(tagsById.get(id) ?? []), tag]);
    }
  }
  const days: Record<string, string> = {};
  for (const id of ids) {
    const day = earliestProductionTagDateV1(tagsById.get(id) ?? [], tagDates);
    if (day) days[id] = day;
  }
  return days;
}

export function whatsNewPublishedSourceV1(
  days: Readonly<Record<string, string>>,
): string {
  const rows = Object.entries(days).map(
    ([id, day]) => `  ${JSON.stringify(id)}: ${JSON.stringify(day)},`,
  );
  return `/** The UTC day each What’s New id first shipped. \`published.ts\` writes it when a tag deploys; the repository keeps it empty. */\nexport const WHATS_NEW_PUBLISHED_V1: Readonly<Record<string, string>> = {${rows.length > 0 ? `\n${rows.join("\n")}\n` : ""}};\n`;
}

function git(args: string[]): string | undefined {
  const run = spawnSync("git", args, {
    cwd: here,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : undefined;
}

function tagDatesInCheckout(): Record<string, string> {
  const listing =
    git([
      "for-each-ref",
      "--format=%(refname:short)%09%(creatordate:iso-strict)",
      "refs/tags",
    ]) ?? "";
  const dates: Record<string, string> = {};
  for (const line of listing.split("\n")) {
    const [tag, instant] = line.split("\t");
    if (tag && instant) dates[tag] = instant;
  }
  return dates;
}

if (import.meta.main) {
  if (git(["rev-parse", "--is-shallow-repository"])?.trim() !== "false") {
    console.warn(
      "::warning::What’s New dates need the full history: this checkout is shallow, so entries a shallow tag hides stay undated.",
    );
  }
  const ids = WHATS_NEW_ENTRIES_V1.map((entry) => entry.id);
  const days = whatsNewPublishedDaysV1(ids, tagDatesInCheckout(), (tag) =>
    whatsNewIdsInSourceV1(git(["show", `${tag}:${ENTRIES_PATH_V1}`]) ?? ""),
  );
  writeFileSync(publishedPath, whatsNewPublishedSourceV1(days));
  const dated = Object.keys(days).length;
  if (dated === 0) {
    console.warn(
      "::warning::No What’s New entry is in a production tag here, so every entry says New. Fetch the tags before running this.",
    );
  }
  console.log(`What’s New: dated ${dated} of ${ids.length} entries.`);
}
