import { describe, expect, test } from "bun:test";
import { PROFILE_MIRROR_KEY_V1 } from "@frockbot/app/flock/profile-mirror";
import {
  cleanBotProfileMirrorTestState,
  cleanDirectoryProfileTestState,
} from "./directory-profile-cleanup.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, value);
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, item);
      }
    }
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
  setAlarm(time: number): Promise<void> {
    this.alarm = time;
    return Promise.resolve();
  }
}

describe("directory profile cleanup", () => {
  test("seeds a missing current profile from the creation name once", async () => {
    const storage = new MemoryStorage() as unknown as DurableObjectStorage;
    const memory = storage as unknown as MemoryStorage;
    memory.values.set("flock:directory:v1", {
      schemaVersion: 1,
      revision: 4,
      bots: [
        {
          schemaVersion: 1,
          botId: "alpha",
          initialName: "Alpha",
          initialDescription: "Persona",
        },
        {
          schemaVersion: 1,
          botId: "beta",
          initialName: "Beta",
          currentProfile: { name: "Kept", sourceRevision: 3 },
        },
      ],
    });
    await cleanDirectoryProfileTestState(storage);
    await cleanDirectoryProfileTestState(storage);
    const stored = memory.values.get("flock:directory:v1") as {
      revision: number;
      bots: Array<{
        botId: string;
        currentProfile?: {
          name: string;
          description?: string;
          sourceRevision: number;
        };
      }>;
    };
    expect(stored.revision).toBe(4);
    expect(stored.bots[0]?.currentProfile).toEqual({
      name: "Alpha",
      description: "Persona",
      sourceRevision: 0,
    });
    expect(stored.bots[1]?.currentProfile).toEqual({
      name: "Kept",
      sourceRevision: 3,
    });
  });

  test("queues the Bot's current settings for the existing alarm", async () => {
    const storage = new MemoryStorage() as unknown as DurableObjectStorage;
    const memory = storage as unknown as MemoryStorage;
    memory.values.set("bot-configuration", {
      schemaVersion: 1,
      botId: "alpha",
      revision: 6,
      profile: { name: "Atlas", description: "Now" },
      notifications: { enabled: true },
      packageValues: {},
    });
    memory.alarm = Date.now() + 60_000;
    await cleanBotProfileMirrorTestState(storage);
    expect(memory.values.get(PROFILE_MIRROR_KEY_V1)).toMatchObject({
      name: "Atlas",
      description: "Now",
      sourceRevision: 6,
    });
    expect(memory.alarm).toBeLessThanOrEqual(Date.now());
    const alarmAfter = memory.alarm;
    await cleanBotProfileMirrorTestState(storage);
    expect(memory.alarm).toBe(alarmAfter);
  });
});
