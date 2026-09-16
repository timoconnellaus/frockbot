import { decodeRoutineRecordV1 } from "@frockbot/app/routines/records";
import {
  ROUTINE_PREFIX,
  routineFireKeyV1,
  routineHookKeyRecordV1,
  routineQueuePrefixV1,
  routineRunPrefixV1,
  routineScheduleKeyV1,
} from "@frockbot/app/routines/storage-keys";

/**
 * Disposable pre-user cleanup for Routine records written with retired
 * trigger shapes. Keep readable Routines; remove each unreadable authority
 * record and the state that can cause it to fire.
 */
export async function cleanRetiredRoutineStateV1(
  storage: DurableObjectStorage,
): Promise<void> {
  const receiptKey = "maintenance:retired-routine-state:2026-09-16";
  await storage.transaction(async (tx) => {
    if (await tx.get(receiptKey)) return;
    const retired: string[] = [];
    const routines = await tx.list<unknown>({ prefix: ROUTINE_PREFIX });
    for (const [key, value] of routines) {
      try {
        decodeRoutineRecordV1(value);
      } catch {
        retired.push(key.slice(ROUTINE_PREFIX.length));
      }
    }
    let deleted = 0;
    for (const routineId of retired) {
      const direct = [
        `${ROUTINE_PREFIX}${routineId}`,
        routineHookKeyRecordV1(routineId),
        routineScheduleKeyV1(routineId),
        routineFireKeyV1(routineId),
      ];
      deleted += await tx.delete(direct);
      for (const prefix of [
        routineQueuePrefixV1(routineId),
        routineRunPrefixV1(routineId),
      ]) {
        for (;;) {
          const keys = [...(await tx.list({ prefix, limit: 128 })).keys()];
          if (keys.length === 0) break;
          deleted += await tx.delete(keys);
        }
      }
    }
    await tx.put(receiptKey, {
      at: new Date().toISOString(),
      retired: retired.length,
      deleted,
    });
  });
}
