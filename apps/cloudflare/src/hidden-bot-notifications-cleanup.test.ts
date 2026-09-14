import { expect, test } from "bun:test";
import { cleanHiddenBotNotifications } from "./hidden-bot-notifications-cleanup.js";

function fixture(settings: unknown) {
  const values = new Map<string, unknown>(
    settings === undefined ? [] : [["bot-configuration", settings]],
  );
  const tx = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
  const storage = {
    async transaction(body: (tx: unknown) => Promise<void>) {
      await body(tx);
    },
  } as unknown as DurableObjectStorage;
  return { values, storage };
}

function settings(hiddenFromSidebar: boolean, enabled: boolean) {
  return {
    schemaVersion: 1,
    botId: "housework",
    revision: 4,
    profile: {
      name: "Housework",
      ...(hiddenFromSidebar ? { hiddenFromSidebar } : {}),
    },
    notifications: { enabled },
    packageValues: {},
  };
}

test("a hidden Bot that still alerts is muted once, with its revision moved", async () => {
  const { values, storage } = fixture(settings(true, true));
  await cleanHiddenBotNotifications(storage);
  // Unread state is not this cleanup's: only the alert switch moves.
  expect(values.get("bot-configuration")).toEqual({
    ...settings(true, false),
    revision: 5,
  });

  // The receipt makes it one-time: a later write is never second-guessed.
  values.set("bot-configuration", settings(true, true));
  await cleanHiddenBotNotifications(storage);
  expect(values.get("bot-configuration")).toEqual(settings(true, true));
});

test("visible, already muted and unmaterialized Bots are untouched", async () => {
  for (const stored of [
    settings(false, true),
    settings(true, false),
    undefined,
  ]) {
    const { values, storage } = fixture(stored);
    await cleanHiddenBotNotifications(storage);
    expect(values.get("bot-configuration")).toEqual(stored);
  }
});
