// Disposable pre-user cleanup for the removed Bot templates.
//
// Bot templates were removed. Their share ledger, import records and command
// receipts lived in the User Durable Object under `bot-template:`, each shared
// recipe was a content-addressed blob at `templates/<hash>.json` in the
// artifact bucket, and every account was seeded an installation row for the
// `bot-template` Package. This deletes the blob each share record names, then
// every `bot-template:` key, then that row. A blob is only ever written beside
// its share record, so the records are the whole index of what to delete. The
// receipt makes a second load free.

const RECEIPT = "maintenance:bot-template-removal:2026-09-25";
const PREFIX = "bot-template:";
const SHARE_PREFIX = `${PREFIX}share:`;
const USER_CONFIGURATION_KEY = "user-configuration";
const PACKAGE_ID = "bot-template";
const PAGE = 50;

interface CleanupStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: {
    prefix: string;
    limit: number;
  }): Promise<Map<string, unknown>>;
}

interface CleanupBucket {
  delete(key: string): Promise<void>;
}

type Stored = Record<string, unknown>;

function record(value: unknown): Stored | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Stored;
}

/** The settings without the retired Package row, or `undefined` to keep them. */
export function withoutBotTemplatePackageV1(
  stored: unknown,
): Stored | undefined {
  const settings = record(stored);
  if (!settings || !Array.isArray(settings.packages)) return undefined;
  const packages = settings.packages.filter(
    (entry) => record(entry)?.packageId !== PACKAGE_ID,
  );
  return packages.length === settings.packages.length
    ? undefined
    : { ...settings, packages };
}

export async function cleanRetiredBotTemplatesV1(
  storage: CleanupStorage,
  bucket?: CleanupBucket,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(RECEIPT)) return;
  let blobs = 0;
  if (bucket) {
    // Blobs go before their records: a wake cut short between the two finds
    // the records still there and deletes the same keys again.
    const hashes = new Set<string>();
    for (const share of (
      await storage.list({ prefix: SHARE_PREFIX, limit: 1_000 })
    ).values()) {
      const hash = record(share)?.hash;
      if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) {
        hashes.add(hash);
      }
    }
    for (const hash of hashes) {
      await bucket.delete(`templates/${hash}.json`);
      blobs += 1;
    }
  }
  let keys = 0;
  for (;;) {
    const listed = await storage.list({ prefix: PREFIX, limit: PAGE });
    for (const key of listed.keys()) {
      await storage.delete(key);
      keys += 1;
    }
    if (listed.size < PAGE) break;
  }
  const settings = withoutBotTemplatePackageV1(
    await storage.get(USER_CONFIGURATION_KEY),
  );
  if (settings) await storage.put(USER_CONFIGURATION_KEY, settings);
  await storage.put(RECEIPT, {
    at: now.toISOString(),
    keys,
    blobs,
    packageRow: settings !== undefined,
  });
}
