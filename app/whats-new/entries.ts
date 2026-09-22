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
    id: "header-align",
    title: "Chat header lines up",
    summary: "The back arrow, avatar, name, and panel icon share one center.",
    kind: "fix",
    image: {
      file: "header-align.webp",
      alt: "The phone chat header with Pixel, Dog, and Cow, each centered with the back arrow, name, and panel icon.",
    },
  },
  {
    id: "quiet-delivery",
    title: "Sends acknowledge immediately",
    summary:
      "A message is accepted as soon as it is saved. A long reply no longer looks like the send failed.",
    kind: "fix",
  },
  {
    id: "chat-scroll",
    title: "Earlier messages stay in reach",
    summary:
      "A long conversation scrolls back to them, and the scrollbar holds its place.",
    kind: "fix",
  },
  {
    id: "marketplace-installed",
    title: "Installed in the Marketplace",
    summary:
      "Configure or remove added models and connectors from Installed. Models and Connectors are checkboxes under search.",
    kind: "improvement",
  },
  {
    id: "chat-type",
    title: "Easier reading in chat",
    summary: "Messages use Inter at 14, with more air between list items.",
    kind: "improvement",
    image: {
      file: "chat-type.webp",
      alt: "A Bot message in Inter, with air between list items.",
    },
  },
  {
    id: "whats-new",
    title: "What’s New in the app",
    summary: "What landed in each release.",
    kind: "feature",
    image: {
      file: "whats-new.webp",
      alt: "The What’s New page, with this feature as its first entry.",
    },
  },
];
