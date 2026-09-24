/** User-facing What’s New entries. Dated by the first production tag that ships them. */
import type { WhatsNewEntryFileV1 } from "./entry.ts";
import { WHATS_NEW_ENTRY_FILES_V1 } from "./entries.generated.ts";

export {
  WHATS_NEW_KINDS_V1,
  type WhatsNewEntryFileV1,
  type WhatsNewEntrySourceV1,
  type WhatsNewImageV1,
  type WhatsNewKindV1,
} from "./entry.ts";

/**
 * Newest first by `added`; the id breaks a tie. Each entry is its own file
 * and the order is computed here rather than kept in a list, so two pull
 * requests that each add one do not both edit the same line.
 */
export function orderWhatsNewEntriesV1(
  files: readonly WhatsNewEntryFileV1[],
): WhatsNewEntryFileV1[] {
  return [...files].sort((a, b) =>
    a.added === b.added ? a.id.localeCompare(b.id) : a.added < b.added ? 1 : -1,
  );
}

/**
 * An id is stable: renaming one is a new entry, and a reused id would inherit
 * the earlier tag’s date.
 */
export const WHATS_NEW_ENTRIES_V1: readonly WhatsNewEntryFileV1[] =
  orderWhatsNewEntriesV1(WHATS_NEW_ENTRY_FILES_V1);
