// Disposable cleanup for the S3 invalidation log and pending stubs S5
// replaced with PublicationHead / ConversationUpdate records.
//
// Old channel events cannot be replayed as typed updates, and a pending
// marker without a kind is not a recoverable obligation. Live S5 pending
// records (with kind, entityId, revision) stay: they still need a drain.

import {
  PUBLICATION_CURSOR_KEY,
  PUBLICATION_PENDING_PREFIX,
  RETIRED_CHANNEL_EVENT_PREFIX_V1,
  RETIRED_CHANNEL_META_KEY_V1,
} from "@frockbot/core/durable";

const RECEIPT = "maintenance:publication:s5:2026-09-22";
const PAGE = 50;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isLivePending(value: unknown): boolean {
  const stored = record(value);
  return (
    stored !== undefined &&
    stored.schemaVersion === 1 &&
    typeof stored.kind === "string" &&
    typeof stored.entityId === "string" &&
    Number.isSafeInteger(stored.cursor) &&
    Number.isSafeInteger(stored.revision)
  );
}

async function page(
  storage: CleanupStorage,
  prefix: string,
  visit: (key: string, value: unknown) => Promise<void>,
): Promise<void> {
  let start: string | undefined;
  for (;;) {
    const listed = await storage.list({
      prefix,
      limit: PAGE,
      ...(start ? { start } : {}),
    });
    if (listed.size === 0) return;
    let last = "";
    for (const [key, value] of listed) {
      last = key;
      if (start !== undefined && key === start) continue;
      await visit(key, value);
    }
    if (listed.size < PAGE) return;
    start = `${last}\0`;
  }
}

export async function cleanRetiredPublicationStateV1(
  storage: CleanupStorage,
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let removed = 0;
  if (await storage.delete(RETIRED_CHANNEL_META_KEY_V1)) removed += 1;
  if (await storage.delete(PUBLICATION_CURSOR_KEY)) removed += 1;
  await page(storage, RETIRED_CHANNEL_EVENT_PREFIX_V1, async (key) => {
    await storage.delete(key);
    removed += 1;
  });
  await page(storage, PUBLICATION_PENDING_PREFIX, async (key, value) => {
    if (isLivePending(value)) return;
    await storage.delete(key);
    removed += 1;
  });
  await storage.put(RECEIPT, {
    schemaVersion: 1,
    removed,
  });
}
