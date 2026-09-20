// Disposable pre-user cleanup for retired default-Package bootstrap markers.
//
// Markers v1–v3 are `{ schemaVersion: 1 | 2 | 3 }` with no ledger. The decoder
// no longer accepts them. This pass deletes those records before any request
// or alarm can read settings, so the next read is the no-marker seed. A v4
// ledger is left alone. The receipt makes a second load free.

export const DEFAULT_PACKAGES_MARKER_KEY = "user-default-packages-bootstrap:v1";
export const DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY =
  "maintenance:default-packages-marker:2026-09-20";

export function isRetiredDefaultPackagesMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "schemaVersion") return false;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  return version === 1 || version === 2 || version === 3;
}

export async function cleanDefaultPackagesMarkerV1(
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY)) return;
  await storage.transaction(async (tx) => {
    if (await tx.get(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY)) return;
    const marker = await tx.get<unknown>(DEFAULT_PACKAGES_MARKER_KEY);
    const removed = isRetiredDefaultPackagesMarker(marker);
    if (removed) {
      await tx.delete(DEFAULT_PACKAGES_MARKER_KEY);
    }
    await tx.put(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY, {
      at: now.toISOString(),
      removed,
    });
  });
}
