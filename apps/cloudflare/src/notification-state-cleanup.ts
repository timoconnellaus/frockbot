/** Disposable pre-user projection cleanup. Message history and Bot settings are retained. */
export async function cleanNotificationTestState(
  storage: DurableObjectStorage,
): Promise<void> {
  const receiptKey = "maintenance:message-notifications:2026-09-09";
  await storage.transaction(async (tx) => {
    if (await tx.get(receiptKey)) return;
    let deleted = 0;
    for (const prefix of ["shell:unread", "notification:"]) {
      for (;;) {
        const keys = [...(await tx.list({ prefix, limit: 128 })).keys()];
        if (!keys.length) break;
        deleted += await tx.delete(keys);
      }
    }
    await tx.put(receiptKey, { at: new Date().toISOString(), deleted });
  });
}
