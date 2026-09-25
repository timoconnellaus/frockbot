// The disposable cleanup for the retired Bot title, against the real Durable
// Object that runs it in its constructor.
//
// The release requires it: a Bot whose profile still carries a `title` must
// come back readable — its settings, and every run that kept a copy of them —
// and must still answer the next message. Only an evicted object can make that
// claim, because the cleanup runs before any request can read the old records.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

const RECEIPT = "maintenance:bot-title-removal:2026-09-25";

type Profile = Record<string, unknown>;

interface StoredRunProbe {
  configurationSnapshot: { profile: Profile };
  preparedInputs: { bot: { settings: { profile: Profile } } };
}

interface BotRpc {
  readConfiguration(input: unknown): Promise<{
    revision: number;
    profile: Profile;
  }>;
  run(command: unknown): Promise<{ runId: string; text: string }>;
  lookupRun(input: unknown): Promise<{ state: string }>;
}

test("a Bot with a title comes back readable, and answers the next message", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `title-cleanup-user-${suffix}`,
    botId: `title-cleanup-bot-${suffix}`,
  };
  await provisionBot(identity);
  const stub = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  const rpc = stub as unknown as BotRpc;
  const turn = (runId: string, text: string) =>
    rpc.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text,
      },
    });

  const first = await turn(`before-${suffix}`, "hello");
  const before = await rpc.readConfiguration({ schemaVersion: 1, ...identity });

  // The Bot as this deployment finds it: titled, in its settings and in the
  // two copies its run kept, and last written by a build without the cleanup.
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `run:${first.runId}`;
    const run = (await state.storage.get<StoredRunProbe>(key))!;
    run.configurationSnapshot.profile.title = "Chief of staff";
    run.preparedInputs.bot.settings.profile.title = "Chief of staff";
    await state.storage.put(key, run);
    await state.storage.put("bot-configuration", {
      ...before,
      profile: { ...before.profile, title: "Chief of staff" },
    });
    await state.storage.delete(RECEIPT);
  });
  await evictDurableObject(stub);

  const cleaned = await rpc.readConfiguration({
    schemaVersion: 1,
    ...identity,
  });
  expect(cleaned.profile).toEqual(before.profile);
  // The revision moved, so a surface holding the older one is fenced.
  expect(cleaned.revision).toBe(before.revision + 1);
  const run = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoredRunProbe>(`run:${first.runId}`),
  );
  expect(run!.configurationSnapshot.profile).not.toHaveProperty("title");
  expect(run!.preparedInputs.bot.settings.profile).not.toHaveProperty("title");
  // The conversation still reads the Turn that carried it.
  const lookup = await rpc.lookupRun({
    schemaVersion: 1,
    ...identity,
    query: { schemaVersion: 1, runId: first.runId },
  });
  expect(lookup.state).toBe("terminal");

  // And a fresh message is answered.
  const next = await turn(`after-${suffix}`, "still there?");
  expect(next.text.length).toBeGreaterThan(0);
});
