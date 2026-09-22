// Retired authored Markdown fact files. Ordinary workspace files and
// instruction roots are not fact files and are left in place.

export const MEMORY_FACT_CLEANUP_RECEIPT_V1 =
  "maintenance:memory-fact-roots:2026-09-22";
export const MEMORY_FACT_CLEANUP_PAGE_V1 = 50;
const MEMORY_FACT_CLEANUP_PAGES_V1 = 4;

export function isRetiredMemoryFactObjectKeyV1(key: string): boolean {
  return key.endsWith("/profile.md") || key.includes("/log/");
}

interface FactCleanupStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

interface FactCleanupBucketV1 {
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: string[]; cursor?: string; truncated: boolean }>;
  delete(key: string): Promise<void>;
}

/**
 * Deletes one bounded run of retired fact objects under `prefix`. A short
 * page records completion. A full page leaves a cursor for the next start.
 */
export async function cleanRetiredMemoryFactObjectsV1(
  storage: FactCleanupStorageV1,
  bucket: FactCleanupBucketV1,
  prefix: string,
): Promise<number> {
  const stored = await storage.get(MEMORY_FACT_CLEANUP_RECEIPT_V1);
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
  for (let page = 0; page < MEMORY_FACT_CLEANUP_PAGES_V1; page += 1) {
    const listed = await bucket.list({
      prefix,
      limit: MEMORY_FACT_CLEANUP_PAGE_V1,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of listed.keys) {
      if (!key.startsWith(prefix) || !isRetiredMemoryFactObjectKeyV1(key)) {
        continue;
      }
      await bucket.delete(key);
      removed += 1;
    }
    if (!listed.truncated) {
      await storage.put(MEMORY_FACT_CLEANUP_RECEIPT_V1, {
        schemaVersion: 1,
        done: true,
        prefix,
        removed,
      });
      return removed;
    }
    cursor = listed.cursor;
  }
  await storage.put(MEMORY_FACT_CLEANUP_RECEIPT_V1, {
    schemaVersion: 1,
    done: false,
    prefix,
    cursor,
    removed,
  });
  return removed;
}
