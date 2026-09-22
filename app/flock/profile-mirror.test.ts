import { describe, expect, test } from "bun:test";
import type { BotDirectoryViewV1 } from "./shared.js";
import {
  deliverProfileMirrorV1,
  directoryProfileFromBotProfileV1,
  PROFILE_MIRROR_KEY_V1,
  PROFILE_MIRROR_RETRY_MS_V1,
  profileMirrorDeadlineV1,
  queueProfileMirrorV1,
  type PendingProfileMirrorV1,
} from "./profile-mirror.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function directory(profile?: {
  name: string;
  description?: string;
  sourceRevision: number;
}): BotDirectoryViewV1 {
  return {
    schemaVersion: 1,
    revision: 1,
    bots: [
      {
        schemaVersion: 1,
        botId: "alpha",
        registeredAt: "2026-09-22T00:00:00.000Z",
        initialName: "Alpha",
        avatar: { schemaVersion: 1, characterId: "pixel", primary: "#fc85ae" },
        ...(profile ? { currentProfile: profile } : {}),
      },
    ],
  };
}

describe("profile mirror delivery", () => {
  test("keeps one newer mirror and does not let an older write replace it", async () => {
    const storage = new MemoryStorage();
    const now = 1_000;
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1(
        { name: "Alpha", description: "First" },
        2,
      ),
      now,
    );
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1({ name: "Atlas" }, 4),
      now + 10,
    );
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1({ name: "Alpha" }, 3),
      now + 20,
    );
    expect(
      await storage.get<PendingProfileMirrorV1>(PROFILE_MIRROR_KEY_V1),
    ).toEqual({
      schemaVersion: 1,
      name: "Atlas",
      sourceRevision: 4,
      dueAt: now + 10,
    });
    expect(await profileMirrorDeadlineV1(storage)).toEqual([now + 10]);
  });

  test("a failed delivery leaves the record and a later alarm", async () => {
    const storage = new MemoryStorage();
    const now = 5_000;
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1({ name: "Atlas" }, 2),
      now,
    );
    let alarm: number | undefined;
    let durableBeforeCall = false;
    const result = await deliverProfileMirrorV1({
      storage,
      now,
      botId: "alpha",
      mirror: async () => {
        durableBeforeCall =
          (await storage.get(PROFILE_MIRROR_KEY_V1)) !== undefined;
        throw new Error("user object unreachable");
      },
      refreshAlarm: async (transaction) => {
        const [due] = await profileMirrorDeadlineV1(transaction);
        alarm = due;
      },
    });
    expect(result).toBe("retry");
    expect(durableBeforeCall).toBe(true);
    expect(
      await storage.get<PendingProfileMirrorV1>(PROFILE_MIRROR_KEY_V1),
    ).toMatchObject({
      name: "Atlas",
      sourceRevision: 2,
      dueAt: now + PROFILE_MIRROR_RETRY_MS_V1,
    });
    expect(alarm).toBe(now + PROFILE_MIRROR_RETRY_MS_V1);
  });

  test("success clears only the revision that was delivered", async () => {
    const storage = new MemoryStorage();
    const now = 8_000;
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1({ name: "Atlas" }, 2),
      now,
    );
    let calls = 0;
    await deliverProfileMirrorV1({
      storage,
      now,
      botId: "alpha",
      mirror: async () => {
        calls += 1;
        if (calls === 1) {
          await queueProfileMirrorV1(
            storage,
            directoryProfileFromBotProfileV1({ name: "Later" }, 5),
            now,
          );
        }
        return directory({ name: "Atlas", sourceRevision: 2 });
      },
      refreshAlarm: async () => undefined,
    });
    expect(
      await storage.get<PendingProfileMirrorV1>(PROFILE_MIRROR_KEY_V1),
    ).toMatchObject({
      name: "Later",
      sourceRevision: 5,
    });
    await deliverProfileMirrorV1({
      storage,
      now,
      botId: "alpha",
      mirror: async () => directory({ name: "Later", sourceRevision: 5 }),
      refreshAlarm: async () => undefined,
    });
    expect(storage.values.has(PROFILE_MIRROR_KEY_V1)).toBe(false);
    expect(await profileMirrorDeadlineV1(storage)).toEqual([]);
  });

  test("a directory that no longer lists the Bot drops the mirror", async () => {
    const storage = new MemoryStorage();
    const now = 9_000;
    await queueProfileMirrorV1(
      storage,
      directoryProfileFromBotProfileV1({ name: "Atlas" }, 3),
      now,
    );
    await deliverProfileMirrorV1({
      storage,
      now,
      botId: "alpha",
      mirror: async () => ({ schemaVersion: 1, revision: 4, bots: [] }),
      refreshAlarm: async () => undefined,
    });
    expect(storage.values.has(PROFILE_MIRROR_KEY_V1)).toBe(false);
  });
});
