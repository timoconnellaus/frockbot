// The disposable cleanup for the retired sidebar label, against the real
// Durable Objects that run it in their constructors.
//
// The release requires it: a Bot whose profile still carries a `label` must
// come back readable — its settings, and every run that kept a copy of them —
// and must still answer the next message. A User whose Group Chats still carry
// one must come back with a list the client's wire schema accepts. Only an
// evicted object can make either claim, because the cleanups run before any
// request can read the old records.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { isProtocolValue } from "@frockbot/core/protocol-schemas";
import { provisionBot } from "./provision-bot.ts";

const BOT_RECEIPT = "maintenance:bot-label-removal:2026-09-25";
const USER_RECEIPT = "maintenance:group-label-removal:2026-09-25";

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

test("a Bot with a label comes back readable, and answers the next message", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `label-cleanup-user-${suffix}`,
    botId: `label-cleanup-bot-${suffix}`,
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

  // The Bot as this deployment finds it: labelled, in its settings and in the
  // two copies its run kept, and last written by a build without the cleanup.
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `run:${first.runId}`;
    const run = (await state.storage.get<StoredRunProbe>(key))!;
    run.configurationSnapshot.profile.label = "Work";
    run.preparedInputs.bot.settings.profile.label = "Work";
    await state.storage.put(key, run);
    await state.storage.put("bot-configuration", {
      ...before,
      profile: { ...before.profile, label: "Work" },
    });
    await state.storage.delete(BOT_RECEIPT);
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
  expect(run!.configurationSnapshot.profile).not.toHaveProperty("label");
  expect(run!.preparedInputs.bot.settings.profile).not.toHaveProperty("label");
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

test("a User whose Group Chats carry a label comes back with a list the client reads", async () => {
  const userId = `label-cleanup-groups-${crypto.randomUUID()}`;
  const stub = env.USER_CONFIGURATIONS.getByName(userId);
  const group = {
    schemaVersion: 1,
    groupId: "g-0123456789abcdef0123",
    members: ["general", "xero"],
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
  };
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("group-chat:list:v1", {
      schemaVersion: 1,
      revision: 2,
      groups: [{ ...group, label: "Work" }],
    });
    await state.storage.delete(USER_RECEIPT);
  });
  await evictDurableObject(stub);

  const list = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get("group-chat:list:v1"),
  );
  expect(list).toEqual({ schemaVersion: 1, revision: 3, groups: [group] });
  expect(isProtocolValue("GroupChatList", list)).toBe(true);
});
