// Disposable pre-user cleanup for the retired pairing code.
//
// The desktop app now enrolls its Mac with its own session, so no pairing
// offer is minted and none is read. An offer left unspent sits in the User
// object under `machine-pair:` and no code path reaches it; this deletes them
// once per object, in pages, and records a receipt so a second load is free.

export const MACHINE_PAIRING_CLEANUP_RECEIPT_KEY =
  "maintenance:machine-pairing:2026-09-30";
const MACHINE_PAIRING_PREFIX = "machine-pair:";
const PAGE = 128;

export interface MachinePairingCleanupStorageV1 {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options: {
    prefix: string;
    limit: number;
  }): Promise<Map<string, T>>;
}

export async function cleanRetiredMachinePairingsV1(
  storage: MachinePairingCleanupStorageV1,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(MACHINE_PAIRING_CLEANUP_RECEIPT_KEY)) return;
  let removed = 0;
  for (;;) {
    const page = await storage.list({
      prefix: MACHINE_PAIRING_PREFIX,
      limit: PAGE,
    });
    if (page.size === 0) break;
    removed += await storage.delete([...page.keys()]);
    if (page.size < PAGE) break;
  }
  await storage.put(MACHINE_PAIRING_CLEANUP_RECEIPT_KEY, {
    at: now.toISOString(),
    removed,
  });
}
