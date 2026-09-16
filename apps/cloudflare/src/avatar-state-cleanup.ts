/**
 * Disposable pre-user cleanup for the retired layered-sheep appearance.
 *
 * Directory registrations are retained so their conversations remain
 * reachable. Only the incompatible appearance and receipts which fingerprinted
 * it are replaced. Bot objects drop the old identity keys; the new identity is
 * materialized from the cleaned registration on first use.
 */

const USER_RECEIPT = "maintenance:avatar-cast:2026-09-16-v2";
const BOT_RECEIPT = "maintenance:avatar-cast:2026-09-16";
const DIRECTORY_KEY = "flock:directory:v1";

const pixel = { schemaVersion: 1, characterId: "pixel", primary: "#fc85ae" };

function layeredAvatar(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const avatar = value as Record<string, unknown>;
  return (
    typeof avatar.background === "string" ||
    typeof avatar.upper === "string" ||
    typeof avatar.middle === "string" ||
    typeof avatar.lower === "string"
  );
}

export async function cleanUserAvatarTestState(
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.transaction(async (tx) => {
    if (await tx.get(USER_RECEIPT)) return;
    const stored = await tx.get<unknown>(DIRECTORY_KEY);
    let replaced = 0;
    if (
      typeof stored === "object" &&
      stored !== null &&
      !Array.isArray(stored)
    ) {
      const directory = stored as Record<string, unknown>;
      if (Array.isArray(directory.bots)) {
        const bots = directory.bots.map((entry) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            return entry;
          }
          const registration = entry as Record<string, unknown>;
          const carriedSheep = Object.hasOwn(registration, "sheep");
          if (!carriedSheep && !layeredAvatar(registration.avatar))
            return entry;
          replaced += 1;
          const { sheep: _retired, ...current } = registration;
          return {
            ...current,
            avatar: layeredAvatar(registration.avatar)
              ? { ...pixel }
              : (registration.avatar ?? { ...pixel }),
          };
        });
        if (replaced > 0) await tx.put(DIRECTORY_KEY, { ...directory, bots });
      }
    }
    let deletedReceipts = 0;
    for (;;) {
      const keys = [
        ...(
          await tx.list({ prefix: "flock:create-receipt:", limit: 128 })
        ).keys(),
      ];
      if (!keys.length) break;
      deletedReceipts += await tx.delete(keys);
    }
    await tx.put(USER_RECEIPT, {
      schemaVersion: 1,
      replaced,
      deletedReceipts,
      completedAt: new Date().toISOString(),
    });
  });
}

export async function cleanBotAvatarTestState(
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.transaction(async (tx) => {
    if (await tx.get(BOT_RECEIPT)) return;
    let deleted = (await tx.delete("flock:sheep:v1")) ? 1 : 0;
    for (;;) {
      const keys = [
        ...(
          await tx.list({ prefix: "flock:sheep-receipt:", limit: 128 })
        ).keys(),
      ];
      if (!keys.length) break;
      deleted += await tx.delete(keys);
    }
    await tx.put(BOT_RECEIPT, {
      schemaVersion: 1,
      deleted,
      completedAt: new Date().toISOString(),
    });
  });
}
