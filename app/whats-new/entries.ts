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
    id: "voice-opening",
    title: "The first words of a call are kept",
    summary:
      "Speech at the start of a call is held until the line is ready, then sent in order.",
    kind: "improvement",
  },
  {
    id: "committed-chat",
    title: "Replies land as they are sent",
    summary:
      "A Bot’s message appears in the thread as soon as it is committed, without waiting for a refresh.",
    kind: "improvement",
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
