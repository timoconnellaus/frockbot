/** The shape of a What’s New entry. Each one is a file under `entries/`. */

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
 * An entry as its file declares it. `added` is the UTC instant the entry was
 * written, `YYYY-MM-DDTHH:MM:SSZ`. It orders the feed and never ships: the
 * day a person sees comes from the first production tag.
 */
export type WhatsNewEntryFileV1 = WhatsNewEntrySourceV1 & { added: string };
