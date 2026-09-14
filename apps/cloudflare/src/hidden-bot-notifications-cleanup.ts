import { BOT_CONFIGURATION_KEY } from "@frockbot/app/settings/bot";

/**
 * Disposable pre-user settings cleanup: a Bot hidden before hiding muted it
 * stops alerting. Only the notification switch and the revision move, so an
 * open settings surface fences on the record it now reads.
 */
export async function cleanHiddenBotNotifications(
  storage: DurableObjectStorage,
): Promise<void> {
  const receiptKey = "maintenance:hidden-bot-notifications:2026-09-14";
  await storage.transaction(async (tx) => {
    if (await tx.get(receiptKey)) return;
    const stored = await tx.get<{
      revision?: unknown;
      profile?: { hiddenFromSidebar?: unknown };
      notifications?: { enabled?: unknown };
    }>(BOT_CONFIGURATION_KEY);
    const muted =
      stored?.profile?.hiddenFromSidebar === true &&
      stored.notifications?.enabled === true &&
      typeof stored.revision === "number";
    if (muted) {
      await tx.put(BOT_CONFIGURATION_KEY, {
        ...stored,
        revision: (stored.revision as number) + 1,
        notifications: { ...stored.notifications, enabled: false },
      });
    }
    await tx.put(receiptKey, { at: new Date().toISOString(), muted });
  });
}
