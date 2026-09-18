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
  THEME_ASSEMBLE_DUE_KEY_V1,
} from "./assemble.js";
import type { BotPluginRosterV1 } from "@frockbot/app/plugins/worker-bot";

class MemoryStorage {
  values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T | undefined);
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
        [...this.values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<
          [string, T]
        >,
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
                hooks: hooks as BotPluginRosterV1["members"][number]["descriptor"]["hooks"],
                grants: [],
                contextKeys: [],
              },
            } as BotPluginRosterV1["members"][number],
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
      },
    );
    expect(first.document?.tokens.surfaces.accent).toBe("#9c1a44");
    expect(first.look).toBe("custom");
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
      },
    );
    expect(kept.document?.tokens.surfaces.accent).toBe("#9c1a44");
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
