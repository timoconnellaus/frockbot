// Disposable cleanup for directory rows written before they carried a
// current profile. Seeds the projection from the creation name. Each Bot
// also queues one mirror of its settings so a rename made before this
// shape converges the next time that Bot wakes. Neither path scans other Bots.

import {
  decodeBotSettingsViewV1,
  migrateStoredBotSettingsV1,
} from "@frockbot/core/configuration";
import { directoryProfileFromBotProfileV1 } from "@frockbot/app/flock/profile-mirror";
import {
  PROFILE_MIRROR_KEY_V1,
  queueProfileMirrorV1,
} from "@frockbot/app/flock/profile-mirror";

const USER_RECEIPT = "maintenance:directory-profile:2026-09-22";
const BOT_RECEIPT = "maintenance:profile-mirror:2026-09-22";
const DIRECTORY_KEY = "flock:directory:v1";
const BOT_CONFIGURATION_KEY = "bot-configuration";

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export async function cleanDirectoryProfileTestState(
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.transaction(async (tx) => {
    if (await tx.get(USER_RECEIPT)) return;
    const stored = record(await tx.get(DIRECTORY_KEY));
    let seeded = 0;
    if (stored && Array.isArray(stored.bots)) {
      const bots = stored.bots.map((entry) => {
        const registration = record(entry);
        if (!registration || registration.currentProfile !== undefined) {
          return entry;
        }
        if (typeof registration.initialName !== "string") return entry;
        seeded += 1;
        return {
          ...registration,
          currentProfile: {
            name: registration.initialName,
            ...(typeof registration.initialDescription === "string"
              ? { description: registration.initialDescription }
              : {}),
            sourceRevision: 0,
          },
        };
      });
      if (seeded > 0) await tx.put(DIRECTORY_KEY, { ...stored, bots });
    }
    await tx.put(USER_RECEIPT, {
      schemaVersion: 1,
      seeded,
      completedAt: new Date().toISOString(),
    });
  });
}

export async function cleanBotProfileMirrorTestState(
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.transaction(async (tx) => {
    if (await tx.get(BOT_RECEIPT)) return;
    let queued = false;
    if ((await tx.get(PROFILE_MIRROR_KEY_V1)) === undefined) {
      const stored = await tx.get(BOT_CONFIGURATION_KEY);
      if (stored !== undefined) {
        try {
          const settings = decodeBotSettingsViewV1(
            migrateStoredBotSettingsV1(stored),
          );
          await queueProfileMirrorV1(
            tx,
            directoryProfileFromBotProfileV1(
              settings.profile,
              settings.revision,
            ),
            Date.now(),
          );
          queued = true;
        } catch {
          queued = false;
        }
      }
    }
    await tx.put(BOT_RECEIPT, {
      schemaVersion: 1,
      queued,
      completedAt: new Date().toISOString(),
    });
  });
  if ((await storage.get(PROFILE_MIRROR_KEY_V1)) === undefined) return;
  const due = Date.now();
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > due) await storage.setAlarm(due);
}
