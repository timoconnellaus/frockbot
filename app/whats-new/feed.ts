import {
  WHATS_NEW_ENTRIES_V1,
  WHATS_NEW_KINDS_V1,
  type WhatsNewEntrySourceV1,
  type WhatsNewKindV1,
} from "./entries.js";
import { whatsNewMediaFileV1 } from "./media.js";

export type WhatsNewPublishedAtLookupV1 = (id: string) => string | undefined;

export type WhatsNewImageViewV1 = {
  src: string;
  alt: string;
};

export type WhatsNewEntryViewV1 = {
  id: string;
  title: string;
  summary: string;
  kind: WhatsNewKindV1;
  /** UTC calendar day the first production tag shipped this id, when known. */
  publishedAt?: string;
  image?: WhatsNewImageViewV1;
};

export type WhatsNewFeedViewV1 = {
  schemaVersion: 1;
  entries: WhatsNewEntryViewV1[];
};

const ENTRY_ID_V1 = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function whatsNewImageSrcV1(file: string): string {
  return `/whats-new/${file}`;
}

export function projectWhatsNewEntryV1(
  entry: WhatsNewEntrySourceV1,
  publishedAt?: string,
): WhatsNewEntryViewV1 {
  if (!ENTRY_ID_V1.test(entry.id)) {
    throw new Error(`What’s New id ${JSON.stringify(entry.id)} is not a slug`);
  }
  if (!WHATS_NEW_KINDS_V1.includes(entry.kind)) {
    throw new Error(`What’s New kind ${JSON.stringify(entry.kind)} is unknown`);
  }
  const title = entry.title.trim();
  const summary = entry.summary.trim();
  if (title.length === 0 || summary.length === 0) {
    throw new Error(`What’s New entry ${entry.id} is missing copy`);
  }
  const image = entry.image;
  if (image) {
    const file = whatsNewMediaFileV1(image.file);
    if (!file) {
      throw new Error(`What’s New entry ${entry.id} names an invalid image`);
    }
    const alt = image.alt.trim();
    if (alt.length === 0) {
      throw new Error(`What’s New entry ${entry.id} is missing image alt text`);
    }
    return {
      id: entry.id,
      title,
      summary,
      kind: entry.kind,
      ...(publishedAt ? { publishedAt } : {}),
      image: { src: whatsNewImageSrcV1(file), alt },
    };
  }
  return {
    id: entry.id,
    title,
    summary,
    kind: entry.kind,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export function whatsNewFeedV1(
  publishedAtFor: WhatsNewPublishedAtLookupV1 = () => undefined,
  entries: readonly WhatsNewEntrySourceV1[] = WHATS_NEW_ENTRIES_V1,
): WhatsNewFeedViewV1 {
  const seen = new Set<string>();
  return {
    schemaVersion: 1,
    entries: entries.map((entry) => {
      if (seen.has(entry.id)) {
        throw new Error(`What’s New id ${entry.id} is duplicated`);
      }
      seen.add(entry.id);
      return projectWhatsNewEntryV1(entry, publishedAtFor(entry.id));
    }),
  };
}
