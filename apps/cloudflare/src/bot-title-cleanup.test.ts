import { describe, expect, test } from "bun:test";
import { decodeBotSettingsViewV1 } from "@frockbot/core/configuration";
import { RUN_PREFIX } from "@frockbot/core/durable";
import { cleanBotTitleV1 } from "./bot-title-cleanup.js";

const RECEIPT = "maintenance:bot-title-removal:2026-09-25";

function storageFrom(initial: Record<string, unknown>) {
  const held = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    held,
    writes,
    get: async (key: string) => held.get(key),
    put: async (key: string, value: unknown) => {
      writes.push(key);
      held.set(key, structuredClone(value));
    },
    list: async (options: {
      prefix?: string;
      limit?: number;
      start?: string;
    }) => {
      const entries = [...held.entries()]
        .filter(([key]) => {
          if (options.prefix && !key.startsWith(options.prefix)) return false;
          if (options.start !== undefined && key < options.start) return false;
          return true;
        })
        .sort(([left], [right]) => left.localeCompare(right));
      const limited =
        options.limit === undefined ? entries : entries.slice(0, options.limit);
      return new Map(limited);
    },
  };
}

function settings(profile: Record<string, unknown>, revision = 4) {
  return {
    schemaVersion: 1,
    botId: "housework",
    revision,
    profile,
    notifications: { enabled: true },
    packageValues: {},
  };
}

function run(runId: string, profile: Record<string, unknown>) {
  return {
    runId,
    status: "completed",
    configurationSnapshot: settings(profile),
    preparedInputs: {
      schemaVersion: 1,
      bot: { revision: 4, settings: settings(profile) },
    },
  };
}

const titled = {
  name: "Housework",
  description: "Keeps the house running.",
  title: "Chief of staff",
  sidebarOrder: 1000,
};
const plain = {
  name: "Housework",
  description: "Keeps the house running.",
  sidebarOrder: 1000,
};

describe("Bot title cleanup", () => {
  test("a stored title is what makes the settings unreadable", () => {
    expect(() => decodeBotSettingsViewV1(settings(titled))).toThrow();
  });

  test("strips the title from the settings and from every run, once", async () => {
    const runs = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => {
        const runId = `run-${String(index).padStart(2, "0")}`;
        return [`${RUN_PREFIX}${runId}`, run(runId, titled)];
      }),
    );
    const storage = storageFrom({
      "bot-configuration": settings(titled),
      ...runs,
    });
    await cleanBotTitleV1(storage);

    // The revision moves, so an open settings surface fences on what it reads.
    expect(storage.held.get("bot-configuration")).toEqual(settings(plain, 5));
    expect(
      decodeBotSettingsViewV1(storage.held.get("bot-configuration")).profile,
    ).toEqual(plain);
    // Past a page of runs, every one of them loses both copies.
    for (const [key, stored] of storage.held) {
      if (!key.startsWith(RUN_PREFIX)) continue;
      expect(stored).toEqual(run(key.slice(RUN_PREFIX.length), plain));
    }
    expect(storage.held.get(RECEIPT)).toMatchObject({
      settings: true,
      runs: 60,
    });

    storage.held.set("bot-configuration", settings(titled));
    await cleanBotTitleV1(storage);
    expect(storage.held.get("bot-configuration")).toEqual(settings(titled));
  });

  test("writes nothing but its receipt for a Bot that never had a title", async () => {
    const storage = storageFrom({
      "bot-configuration": settings(plain),
      [`${RUN_PREFIX}one`]: run("one", plain),
      [`${RUN_PREFIX}bare`]: { runId: "bare", status: "failed" },
    });
    await cleanBotTitleV1(storage);
    expect(storage.writes).toEqual([RECEIPT]);
  });

  test("a Bot with no settings yet gets only its receipt", async () => {
    const storage = storageFrom({});
    await cleanBotTitleV1(storage);
    expect(storage.writes).toEqual([RECEIPT]);
  });
});
