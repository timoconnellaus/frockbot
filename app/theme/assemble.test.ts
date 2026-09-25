import { describe, expect, test } from "bun:test";
import { createFlockBotBackendContribution } from "@frockbot/app/flock/bot";
import { randomAvatarAppearanceV1 } from "@frockbot/app/flock/shared";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "@frockbot/core/theme";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  assembleBotThemeV1,
  rosterDeclaresThemeAssembleV1,
} from "./assemble.js";
import {
  deferThemeAssembleV1,
  holdThemePickV1,
  oweThemeAssembleV1,
  THEME_ASSEMBLE_DUE_KEY_V1,
  THEME_ASSEMBLE_TURN_DEFERRAL_MS_V1,
} from "./owed.js";
import type { BotPluginRosterV1 } from "@frockbot/app/plugins/worker-bot";

class MemoryStorage {
  values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }
  put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
  list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(prefix),
        ) as Array<[string, T]>,
      ),
    );
  }
}

const registration = {
  schemaVersion: 1 as const,
  botId: "alpha",
  registeredAt: "2026-09-18T00:00:00.000Z",
  initialName: "Alpha",
  avatar: randomAvatarAppearanceV1(() => 0),
};

function stateOf(storage: MemoryStorage): ShellBotStateV1 {
  return { ctx: { storage } } as unknown as ShellBotStateV1;
}

function roster(hooks: string[] = []): BotPluginRosterV1 {
  return {
    generationId: "gen-1",
    enabled: hooks.length === 0 ? [] : ["dusk"],
    members:
      hooks.length === 0
        ? []
        : [
            {
              packageId: "dusk",
              version: "1",
              descriptor: {
                id: "dusk",
                displayName: "Dusk",
                version: "1",
                contractVersion: 7,
                tools: [],
                hooks:
                  hooks as BotPluginRosterV1["members"][number]["descriptor"]["hooks"],
                grants: [],
                contextKeys: [],
              },
            } as unknown as BotPluginRosterV1["members"][number],
          ],
  };
}

describe("assembleBotThemeV1", () => {
  test("Inherit with no theme Plugin drops the document so the client compiles look", async () => {
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    await flock.readLook(registration, "user-1");
    let mirrored: unknown;
    const next = await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "paper",
        timezone: "UTC",
        roster: roster(),
        mirror: (look, document) => {
          mirrored = { look, document };
          return Promise.resolve();
        },
      },
    );
    expect(next.look).toBe("inherit");
    expect(next.document).toBeUndefined();
    expect(mirrored).toEqual({ look: "inherit", document: undefined });
    expect(storage.values.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);
  });

  test("a Plugin patch is persisted; a throw leaves the last good document", async () => {
    let changes = 0;
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    await flock.updateLook(registration, "user-1", {
      schemaVersion: 1,
      type: "bot/update-look",
      commandId: "look-1",
      expectedRevision: 0,
      botId: "alpha",
      look: "studio",
    });
    const patched = {
      ...STUDIO_DOCUMENT_V1,
      tokens: {
        ...STUDIO_DOCUMENT_V1.tokens,
        surfaces: {
          ...STUDIO_DOCUMENT_V1.tokens.surfaces,
          accent: "#9c1a44",
        },
      },
    };
    const first = await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "ink",
        timezone: "UTC",
        roster: roster(["theme/assemble"]),
        assemble: () => Promise.resolve(patched),
        mirror: () => Promise.resolve(),
        changed: () => {
          changes += 1;
        },
      },
    );
    expect(first.document?.tokens.surfaces.accent).toBe("#9c1a44");
    expect(first.look).toBe("custom");
    expect(changes).toBe(1);
    const kept = await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "ink",
        timezone: "UTC",
        roster: roster(["theme/assemble"]),
        assemble: () => Promise.reject(new Error("plugin threw")),
        mirror: () => Promise.resolve(),
        changed: () => {
          changes += 1;
        },
      },
    );
    expect(kept.document?.tokens.surfaces.accent).toBe("#9c1a44");
    // The look it already wore is not news to a client.
    expect(changes).toBe(1);
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBeGreaterThan(
      Date.now(),
    );
  });

  test("a Plugin patch promotes the pick to Custom so the assembled document is what you see", async () => {
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    await flock.readLook(registration, "user-1");
    const patched = {
      ...INK_DOCUMENT_V1,
      tokens: {
        ...INK_DOCUMENT_V1.tokens,
        surfaces: {
          ...INK_DOCUMENT_V1.tokens.surfaces,
          accent: "#9c1a44",
        },
      },
    };
    const next = await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "ink",
        timezone: "UTC",
        roster: roster(["theme/assemble"]),
        assemble: () => Promise.resolve(patched),
        mirror: () => Promise.resolve(),
      },
    );
    expect(next.look).toBe("custom");
    expect(next.document?.tokens.surfaces.accent).toBe("#9c1a44");
  });

  test("a look the person picked holds over a Plugin until one is asked to set it again", async () => {
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    const canary = {
      ...INK_DOCUMENT_V1,
      tokens: {
        ...INK_DOCUMENT_V1.tokens,
        surfaces: { ...INK_DOCUMENT_V1.tokens.surfaces, accent: "#9c1a44" },
      },
    };
    const assemble = () =>
      assembleBotThemeV1(
        stateOf(storage),
        { userId: "user-1", botId: "alpha" },
        {
          flock,
          registration,
          appearance: "ink",
          timezone: "UTC",
          roster: roster(["theme/assemble"]),
          assemble: () => Promise.resolve(canary),
          mirror: () => Promise.resolve(),
        },
      );
    expect((await assemble()).look).toBe("custom");

    // The person picks Inherit back on the Look page.
    const current = await flock.readLook(registration, "user-1");
    await flock.updateLook(registration, "user-1", {
      schemaVersion: 1,
      type: "bot/update-look",
      commandId: "look-back",
      expectedRevision: current.revision,
      botId: "alpha",
      look: "inherit",
    });
    await holdThemePickV1(storage);
    const held = await assemble();
    expect(held.look).toBe("inherit");
    expect(held.document).toBeUndefined();
    // Nothing is owed on the hour for a Plugin that is not wrapping it.
    expect(storage.values.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);

    // The Plugin is asked to set the look again: it wraps it once more.
    await oweThemeAssembleV1(storage, new Date());
    const resumed = await assemble();
    expect(resumed.look).toBe("custom");
    expect(resumed.document?.tokens.surfaces.accent).toBe("#9c1a44");
  });

  test("Custom with no Plugin keeps the assembled document", async () => {
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    await flock.persistAssembledDocument(
      registration,
      "user-1",
      STUDIO_DOCUMENT_V1,
      "custom",
    );
    const kept = await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "ink",
        timezone: "UTC",
        roster: roster(),
        mirror: () => Promise.resolve(),
      },
    );
    expect(kept.look).toBe("custom");
    expect(kept.document).toEqual(STUDIO_DOCUMENT_V1);
  });

  test("a Plugin switched while it assembles leaves the next assemble owed", async () => {
    const storage = new MemoryStorage();
    const flock = createFlockBotBackendContribution({
      storage,
      materializeSettings: () => Promise.resolve(),
      archiveEligible: () => Promise.resolve(true),
      tearDown: () => Promise.resolve("complete"),
    });
    await flock.readLook(registration, "user-1");
    const now = new Date("2026-09-18T10:15:00.000Z");
    await assembleBotThemeV1(
      stateOf(storage),
      { userId: "user-1", botId: "alpha" },
      {
        flock,
        registration,
        appearance: "paper",
        timezone: "UTC",
        now,
        roster: roster(["theme/assemble"]),
        assemble: async () => {
          await oweThemeAssembleV1(storage, now);
          throw new Error("third failure quarantines the Plugin");
        },
        mirror: () => Promise.resolve(),
      },
    );
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(now.getTime());
  });

  test("the named presets are what Inherit and Studio compile to", () => {
    expect(INK_DOCUMENT_V1.look).toBe("ink");
    expect(PAPER_DOCUMENT_V1.look).toBe("paper");
    expect(STUDIO_DOCUMENT_V1.look).toBe("studio");
  });

  test("a roster without the hook does not declare assemble", () => {
    expect(rosterDeclaresThemeAssembleV1(roster(["agent/request"]))).toBe(
      false,
    );
    expect(rosterDeclaresThemeAssembleV1(roster(["theme/assemble"]))).toBe(
      true,
    );
  });
});

describe("deferThemeAssembleV1", () => {
  test("pushes an assemble already due past a running Turn, and leaves a later one", async () => {
    const storage = new MemoryStorage();
    await storage.put(THEME_ASSEMBLE_DUE_KEY_V1, 1_000);
    await deferThemeAssembleV1(storage, 5_000);
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(
      5_000 + THEME_ASSEMBLE_TURN_DEFERRAL_MS_V1,
    );
    await storage.put(THEME_ASSEMBLE_DUE_KEY_V1, 9_000);
    await deferThemeAssembleV1(storage, 5_000);
    expect(storage.values.get(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(9_000);
    storage.values.delete(THEME_ASSEMBLE_DUE_KEY_V1);
    await deferThemeAssembleV1(storage, 5_000);
    expect(storage.values.has(THEME_ASSEMBLE_DUE_KEY_V1)).toBe(false);
  });
});
