import { WHATS_NEW_ENTRIES_V1, type WhatsNewEntrySourceV1 } from "./entries.js";

export const WHATS_NEW_PREVIEW_PATH_V1 = new URL(
  "./PREVIEW.md",
  import.meta.url,
);

export function whatsNewPreviewMarkdownV1(
  entries: readonly WhatsNewEntrySourceV1[] = WHATS_NEW_ENTRIES_V1,
): string {
  const blocks = [
    "# What’s New preview",
    "",
    "Generated from `entries.ts`. Open this file on the pull request to review the copy and the screenshot as they will ship.",
    "",
  ];
  for (const entry of entries) {
    blocks.push(
      `## ${entry.title}`,
      "",
      `${entry.kind}`,
      "",
      entry.summary,
      "",
    );
    if (entry.image) {
      blocks.push(`![${entry.image.alt}](media/${entry.image.file})`, "");
    }
  }
  return `${blocks.join("\n").trimEnd()}\n`;
}
