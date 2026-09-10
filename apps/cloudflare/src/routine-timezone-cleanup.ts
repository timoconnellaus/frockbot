import {
  ROUTINE_ACCOUNT_TIMEZONE_KEY,
  ROUTINE_DELIVERY_PREFIX,
  ROUTINE_DRAIN_PREFIX,
  ROUTINE_FAILURE_MESSAGE_PREFIX,
  ROUTINE_FIRE_PREFIX,
  ROUTINE_INBOX_CURSOR_KEY,
  ROUTINE_INBOX_PREFIX,
  ROUTINE_KEY_PREFIX,
  ROUTINE_PREFIX,
  ROUTINE_QUEUE_PREFIX,
  ROUTINE_RECEIPT_PREFIX,
  ROUTINE_RUN_PREFIX,
  ROUTINE_SCHEDULE_PREFIX,
  ROUTINE_WAKE_CURSOR_KEY,
  ROUTINE_WAKE_PREFIX,
} from "@frockbot/app/routines/storage-keys";

/**
 * Disposable pre-user cleanup for the retired per-Routine timezone shape.
 * A definition written by the previous release cannot be decoded honestly
 * without preserving the field the product removed, so all Routine-owned test
 * state is discarded once while conversation and Bot configuration remain.
 */
export async function cleanRoutineTimezoneTestStateV1(
  storage: DurableObjectStorage,
): Promise<void> {
  const receiptKey = "maintenance:routine-account-timezone:2026-09-10";
  await storage.transaction(async (transaction) => {
    if (await transaction.get(receiptKey)) return;
    let deleted = 0;
    for (const prefix of [
      ROUTINE_PREFIX,
      ROUTINE_RUN_PREFIX,
      ROUTINE_RECEIPT_PREFIX,
      ROUTINE_SCHEDULE_PREFIX,
      ROUTINE_FIRE_PREFIX,
      ROUTINE_QUEUE_PREFIX,
      ROUTINE_KEY_PREFIX,
      ROUTINE_DELIVERY_PREFIX,
      ROUTINE_FAILURE_MESSAGE_PREFIX,
      ROUTINE_INBOX_PREFIX,
      ROUTINE_WAKE_PREFIX,
      ROUTINE_DRAIN_PREFIX,
    ]) {
      for (;;) {
        const keys = [
          ...(await transaction.list({ prefix, limit: 128 })).keys(),
        ];
        if (keys.length === 0) break;
        for (const key of keys) {
          if (await transaction.delete(key)) deleted += 1;
        }
      }
    }
    for (const key of [
      ROUTINE_ACCOUNT_TIMEZONE_KEY,
      ROUTINE_INBOX_CURSOR_KEY,
      ROUTINE_WAKE_CURSOR_KEY,
    ]) {
      if (await transaction.delete(key)) deleted += 1;
    }
    await transaction.put(receiptKey, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      deleted,
    });
  });
}
