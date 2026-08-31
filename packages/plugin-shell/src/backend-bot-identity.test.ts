// Slice B, the durable half: the partial profile command, the provenance it
// records, and the rename announcement it appends to the Bot's Session.
import { describe, expect, test } from "bun:test";
import type { BotSettingsViewV1 } from "@frockbot/configuration-core";
import { createShellBotBackendContribution } from "./backend.js";
import { BOT_ANNOUNCEMENT_RETENTION } from "./backend.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let removed = 0;
      for (const entry of key) if (this.values.delete(entry)) removed += 1;
      return Promise.resolve(removed);
    }
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()]
          .filter(([key]) => key.startsWith(options.prefix ?? ""))
          .sort(([left], [right]) => left.localeCompare(right)) as Array<
          [string, T]
        >,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

const identity = { userId: "user-1", botId: "primary" };

function contributionOn(storage: MemoryStorage) {
  return createShellBotBackendContribution({
    state: { storage } as unknown as DurableObjectState,
    env: {} as never,
  });
}

async function setProfile(
  contribution: ReturnType<typeof contributionOn>,
  commandId: string,
  expectedRevision: number,
  profile: Record<string, unknown>,
  namedBy?: "user" | "bot",
  writer?: Record<string, unknown>,
): Promise<void> {
  await contribution.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    botId: identity.botId,
    command: {
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId,
      botId: identity.botId,
      expectedRevision,
      ...(namedBy ? { namedBy } : {}),
      ...(writer ? { writer } : {}),
      profile,
    },
  });
}

describe("bot/set-profile", () => {
  test("changes only the fields the command carries", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    await contribution.materializeSettings(identity, { name: "Housework" });
    await setProfile(contribution, "title-1", 0, {
      title: "Chief of staff",
      description: "Keeps things tidy.",
    });
    await setProfile(contribution, "hide-1", 1, { hiddenFromSidebar: true });

    const settings = (await storage.get(
      "bot-configuration",
    )) as BotSettingsViewV1;
    expect(settings.profile).toEqual({
      name: "Housework",
      title: "Chief of staff",
      description: "Keeps things tidy.",
      hiddenFromSidebar: true,
    });
    expect(settings.revision).toBe(2);
    // Neither command touched the name, so neither recorded a writer for it.
    expect(settings.profile.namedBy).toBeUndefined();
  });

  test("records the writer of a rename and announces it in the Session", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    await contribution.materializeSettings(identity, { name: "Housework" });
    await setProfile(contribution, "rename-1", 0, { name: "Atlas" }, "bot");

    const settings = (await storage.get(
      "bot-configuration",
    )) as BotSettingsViewV1;
    expect(settings.profile).toEqual({ name: "Atlas", namedBy: "bot" });
    const announcements = await contribution.listAnnouncements();
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      type: "bot/renamed",
      seq: 0,
      from: "Housework",
      to: "Atlas",
      namedBy: "bot",
    });
  });

  test("a Bot's self-rename carries its writer into the announcement", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    const writer = {
      kind: "bot",
      botId: identity.botId,
      sessionId: "user-1:primary",
      turnId: "turn-4",
    };
    await contribution.materializeSettings(identity, { name: "Housework" });
    await setProfile(
      contribution,
      "rename-1",
      0,
      { name: "Atlas" },
      "bot",
      writer,
    );
    // A User edit that happens to carry no writer still announces as before.
    await setProfile(contribution, "rename-2", 1, { name: "Housework" });

    const announcements = await contribution.listAnnouncements();
    expect(announcements[0]).toMatchObject({ namedBy: "bot", writer });
    expect(announcements[1]).toMatchObject({ namedBy: "user" });
    expect(announcements[1]).not.toHaveProperty("writer");
  });

  test("announces a User rename by default and never for an unchanged name", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    await contribution.materializeSettings(identity, { name: "Housework" });
    await setProfile(contribution, "rename-1", 0, { name: "Atlas" });
    await setProfile(contribution, "same-1", 1, { name: "Atlas" });
    await setProfile(contribution, "title-1", 2, { title: "Chief" });

    const announcements = await contribution.listAnnouncements();
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({ namedBy: "user", to: "Atlas" });
  });

  test("bounds the announcement log and keeps the newest renames", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    await contribution.materializeSettings(identity, { name: "name-0" });
    const renames = BOT_ANNOUNCEMENT_RETENTION + 3;
    for (let index = 1; index <= renames; index += 1) {
      await setProfile(contribution, `rename-${index}`, index - 1, {
        name: `name-${index}`,
      });
    }
    const announcements = await contribution.listAnnouncements();
    expect(announcements).toHaveLength(BOT_ANNOUNCEMENT_RETENTION);
    expect(announcements.at(-1)).toMatchObject({ to: `name-${renames}` });
    expect(announcements[0]).toMatchObject({
      to: `name-${renames - BOT_ANNOUNCEMENT_RETENTION + 1}`,
    });
  });

  test("a rename announcement rides the run list the Session shows", async () => {
    const storage = new MemoryStorage();
    const contribution = contributionOn(storage);
    await contribution.materializeSettings(identity, { name: "Housework" });
    await setProfile(contribution, "rename-1", 0, { name: "Atlas" }, "user");

    const page = await contribution.listRuns({ schemaVersion: 1 });
    expect(page.announcements).toEqual([
      {
        type: "bot/renamed",
        announcementId: "announcement-0",
        at: expect.any(String),
        from: "Housework",
        to: "Atlas",
        namedBy: "user",
      },
    ]);
  });
});
