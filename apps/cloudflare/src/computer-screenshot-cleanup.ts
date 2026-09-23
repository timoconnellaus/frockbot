// Retired Computer screenshot files. The card's picture is now one frame in
// the Bot's own storage; the viewer-close captures this Bot filed in the
// User's `screenshots` root in object storage are read by nothing.

export const COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1 =
  "maintenance:computer-screenshots:2026-09-23";
export const COMPUTER_SCREENSHOT_CLEANUP_PAGE_V1 = 100;
const COMPUTER_SCREENSHOT_CLEANUP_PAGES_V1 = 4;

interface ScreenshotCleanupStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

interface ScreenshotCleanupBucketV1 {
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: string[]; cursor?: string; truncated: boolean }>;
  delete(key: string): Promise<void>;
}

/**
 * Deletes one bounded run of this Bot's objects under `prefix`, its directory
 * in the `screenshots` root, tombstones and conflict copies included. A short
 * page records completion; a full page leaves a cursor for the next start.
 *
 * A bulk removal rather than `WorkspaceStore.delete`, as a Bot's own deletion
 * is: nothing will ever read these files, so there is no generation to fence.
 */
export async function cleanRetiredComputerScreenshotsV1(
  storage: ScreenshotCleanupStorageV1,
  bucket: ScreenshotCleanupBucketV1,
  prefix: string,
): Promise<number> {
  const stored = await storage.get(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1);
  const receipt =
    stored && typeof stored === "object"
      ? (stored as { done?: boolean; cursor?: string; prefix?: string })
      : undefined;
  if (receipt?.done && receipt.prefix === prefix) return 0;
  let cursor =
    receipt?.prefix === prefix && typeof receipt.cursor === "string"
      ? receipt.cursor
      : undefined;
  let removed = 0;
  for (let page = 0; page < COMPUTER_SCREENSHOT_CLEANUP_PAGES_V1; page += 1) {
    const listed = await bucket.list({
      prefix,
      limit: COMPUTER_SCREENSHOT_CLEANUP_PAGE_V1,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of listed.keys) {
      if (!key.startsWith(prefix)) continue;
      await bucket.delete(key);
      removed += 1;
    }
    if (!listed.truncated) {
      await storage.put(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1, {
        schemaVersion: 1,
        done: true,
        prefix,
        removed,
      });
      return removed;
    }
    cursor = listed.cursor;
  }
  await storage.put(COMPUTER_SCREENSHOT_CLEANUP_RECEIPT_V1, {
    schemaVersion: 1,
    done: false,
    prefix,
    cursor,
    removed,
  });
  return removed;
}
