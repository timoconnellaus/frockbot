/** User-facing What’s New entries. Dated by the first production tag that ships them. */

export const WHATS_NEW_KINDS_V1 = ["feature", "improvement", "fix"] as const;
export type WhatsNewKindV1 = (typeof WHATS_NEW_KINDS_V1)[number];

export type WhatsNewImageV1 = {
  /** File under `media/`, served at `/whats-new/<file>`. */
  file: string;
  alt: string;
};

export type WhatsNewEntrySourceV1 = {
  id: string;
  title: string;
  summary: string;
  kind: WhatsNewKindV1;
  image?: WhatsNewImageV1;
};

/**
 * Newest first. An id is stable: renaming one is a new entry, and a reused
 * id would inherit the earlier tag’s date.
 */
export const WHATS_NEW_ENTRIES_V1: readonly WhatsNewEntrySourceV1[] = [
  {
    id: "whats-new",
    title: "What’s New in the app",
    summary:
      "After an update, open What’s New from your profile to see what shipped. A mark appears when there is something you have not read.",
    kind: "feature",
    image: {
      file: "whats-new.webp",
      alt: "The What’s New page, with this feature as its first entry.",
    },
  },
];
