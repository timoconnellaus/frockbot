// The disposable cleanup that a Bot hidden before hiding muted it runs when it
// is next loaded, against a real Bot Durable Object.
//
// The release requires it: a Bot the deployment finds hidden and still
// notifying must come back muted, at a settings revision that moved so an open
// surface fences on the record it now reads — and it must stay that way
// without the cleanup deciding again on every load. Only an evicted object can
// make that claim, because the cleanup runs in the constructor, before any
// request can read the old row.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

const RECEIPT_KEY = "maintenance:hidden-bot-notifications:2026-09-14";

interface SettingsRpc {
  readConfiguration(input: unknown): Promise<{
    revision: number;
    profile: { name: string; hiddenFromSidebar?: boolean };
    notifications: { enabled: boolean };
  }>;
}

test("a Bot hidden before hiding muted it comes back muted, once", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    schemaVersion: 1 as const,
    userId: `hidden-cleanup-user-${suffix}`,
    botId: `hidden-cleanup-bot-${suffix}`,
  };
  await provisionBot(identity);
  const stub = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  const rpc = stub as unknown as SettingsRpc;

  const before = await rpc.readConfiguration(identity);

  // The Bot as this deployment finds it: hidden, and still alerting. The
  // maintenance receipt goes with it, because this Bot was last written by the
  // build that had never heard of the cleanup.
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("bot-configuration", {
      ...before,
      revision: before.revision + 1,
      profile: { ...before.profile, hiddenFromSidebar: true },
      notifications: { enabled: true },
    });
    await state.storage.delete(RECEIPT_KEY);
  });
  await evictDurableObject(stub);

  const cleaned = await rpc.readConfiguration(identity);
  expect(cleaned.profile.hiddenFromSidebar).toBe(true);
  expect(cleaned.notifications.enabled).toBe(false);
  // The revision moved, so a surface holding the older one is fenced.
  expect(cleaned.revision).toBe(before.revision + 2);
  // And the Bot's name — everything the cleanup has no business touching —
  // is the record it found.
  expect(cleaned.profile.name).toBe(before.profile.name);

  // Loaded again, the cleanup decides nothing: no second revision, and a Bot
  // the User has since shown and unmuted is left alone.
  await evictDurableObject(stub);
  expect(await rpc.readConfiguration(identity)).toEqual(cleaned);

  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("bot-configuration", {
      ...cleaned,
      revision: cleaned.revision + 1,
      profile: { ...cleaned.profile, hiddenFromSidebar: false },
      notifications: { enabled: true },
    });
  });
  await evictDurableObject(stub);
  const shown = await rpc.readConfiguration(identity);
  expect(shown.notifications.enabled).toBe(true);
  expect(shown.revision).toBe(cleaned.revision + 1);
});
