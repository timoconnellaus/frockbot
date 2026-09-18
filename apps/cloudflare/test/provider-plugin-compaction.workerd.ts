// Provider Plugins must serve background compaction on the same admitted model
// binding as ordinary Turns, with the durable compaction effect as its key.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";
import type { SessionEvent } from "@frockbot/core/contracts";
import { whenCompactionSettledV1 } from "../../../app/shell/compaction-scheduler.ts";
import { DEEPSEEK_TEST_API_KEY, WEB_STUB_ORIGIN } from "./harness/miniflare.ts";
import { flockRevision } from "./provision-bot.ts";

interface Identity {
  userId: string;
  botId: string;
}

interface UserRpc {
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<{ status: string }>;
  executeConnection(
    input: unknown,
  ): Promise<{ status: string; connectionId: string }>;
  createBot(input: unknown): Promise<unknown>;
}

function bot(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

async function provision(identity: Identity): Promise<void> {
  // SAFETY: avoid expanding the generated recursive RPC stub type; these are
  // the ordinary account commands this test exercises.
  const user = env.USER_CONFIGURATIONS.getByName(
    identity.userId,
  ) as unknown as UserRpc;
  const revision = async () =>
    (
      await user.readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      })
    ).revision;
  for (const command of [
    {
      type: "user/set-package-enabled",
      packageId: "custom-models",
      enabled: true,
    },
    {
      type: "user/install-package",
      packageId: "provider-deepseek",
      version: "0.0.1",
    },
  ]) {
    const receipt = await user.executeConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        commandId: `${command.packageId}-${identity.botId}`,
        expectedRevision: await revision(),
        ...command,
      },
    });
    expect(receipt.status).toBe("applied");
  }
  const connection = await user.executeConnection({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `connect-${identity.botId}`,
      packageId: "provider-deepseek",
      connectionTypeId: "deepseek-account",
      label: "Compaction test",
      apiKey: DEEPSEEK_TEST_API_KEY,
    },
  });
  expect(connection.status).toBe("applied");
  const selected = await user.executeConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "user/set-account-model",
      commandId: `model-${identity.botId}`,
      expectedRevision: await revision(),
      model: {
        connectionId: connection.connectionId,
        providerModelId: "deepseek-v4-pro",
      },
    },
  });
  expect(selected.status).toBe("applied");
  await user.createBot({
    schemaVersion: 1,
    userId: identity.userId,
    command: {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${identity.botId}`,
      expectedRevision: await flockRevision(identity.userId),
      botId: identity.botId,
      name: "Compaction test Bot",
    },
  });
}

interface BotRpc {
  run(input: unknown): Promise<{ text: string }>;
  durableSessionEvents(): Promise<SessionEvent[]>;
}

async function calls(): Promise<Array<{ idempotencyKey: string | null }>> {
  const response = await fetch(`${WEB_STUB_ORIGIN}/deepseek-calls`);
  return (
    (await response.json()) as {
      calls: Array<{ idempotencyKey: string | null }>;
    }
  ).calls;
}

// Match the ordinary compaction suite: a dozen 13k-character user Turns pass
// the history threshold while leaving the four newest Turns uncompressed.
function say(index: number): string {
  return `Turn ${index} says: ${"detail ".repeat(13_000 / 7)}`;
}

test("a provider Plugin compacts a long conversation durably under the compaction effect's idempotency key", async () => {
  expect("STRIPE_SECRET_KEY" in env).toBe(false);
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `plugin-compaction-${suffix}`,
    botId: `plugin-compaction-bot-${suffix}`,
  };
  await provision(identity);
  await fetch(`${WEB_STUB_ORIGIN}/forget-deepseek-calls`);
  const sessionId = `${identity.userId}:${identity.botId}`;
  // SAFETY: the generated recursive stub type cannot be expanded here; this
  // names the two public RPC methods the test invokes.
  const rpc = () => bot(identity) as unknown as BotRpc;
  const turn = async (index: number) => {
    const result = await rpc().run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `compaction-turn-${index}`,
        sessionId,
        acceptedAt: new Date().toISOString(),
        text: say(index),
      },
    });
    expect(result.text).toContain("DeepSeek says hello");
    // The public Turn has already returned. Let its detached summary finish
    // before admitting another message, which intentionally aborts summaries.
    // Await the scheduler in the object's context, without timing sleeps or
    // making the production Turn wait for compaction.
    await runInDurableObject(bot(identity), () =>
      whenCompactionSettledV1(sessionId),
    );
  };

  for (let index = 1; index <= 11; index += 1) await turn(index);
  const events = await rpc().durableSessionEvents();
  expect(
    events.filter((event) => event.type === "conversation/compaction-failed"),
  ).toEqual([]);
  const compactions = events.filter(
    (event) => event.type === "conversation/compacted",
  );
  expect(compactions).toHaveLength(1);
  const compacted = compactions[0];
  if (compacted?.type !== "conversation/compacted") {
    throw new Error("the provider Plugin did not persist its summary");
  }
  expect(compacted.provider).toBe("deepseek");
  expect(compacted.model).toBe("deepseek-v4-pro");
  expect(compacted.summary).toContain("DeepSeek durable summary");
  expect(compacted.fromTurn).toBe(1);
  expect(compacted.throughTurn).toBeGreaterThan(0);
  expect(compacted.throughTurn).toBeLessThanOrEqual(7);
  const intents = events.filter(
    (event) =>
      event.type === "conversation/compaction-intent" &&
      event.effectId === compacted.effectId,
  );
  expect(intents).toHaveLength(1);
  expect(intents[0]!.seq).toBeLessThan(compacted.seq);
  const beforeEviction = await calls();
  expect(
    beforeEviction.filter((call) => call.idempotencyKey === compacted.effectId),
  ).toHaveLength(1);

  // The summary is already durable. Eviction and recovery cannot resend its
  // model effect; neither the mounted provider nor its in-memory tickets
  // survive to make this assertion pass accidentally.
  await evictDurableObject(bot(identity));
  await runInDurableObject(bot(identity), (_instance, state) =>
    state.storage.setAlarm(Date.now() + 60_000),
  );
  expect(await runDurableObjectAlarm(bot(identity))).toBe(true);
  expect(await calls()).toEqual(beforeEviction);

  const before = (await rpc().durableSessionEvents()).length;
  await turn(12);
  const after = await rpc().durableSessionEvents();
  const request = after
    .slice(before)
    .findLast((event) => event.type === "model/request");
  if (request?.type !== "model/request") {
    throw new Error("the next Turn has no durable model request");
  }
  const [summary, ...remaining] = request.request.messages;
  expect(summary?.content).toContain(compacted.summary);
  expect(summary?.content).toContain(
    `Turns 1 to ${compacted.throughTurn} of this conversation`,
  );
  for (let index = 1; index <= compacted.throughTurn; index += 1) {
    expect(
      request.request.messages.some((message) =>
        message.content.includes(`Turn ${index} says:`),
      ),
    ).toBe(false);
  }
  expect(
    remaining.some((message) =>
      message.content.startsWith(`Turn ${compacted.throughTurn + 1} says:`),
    ),
  ).toBe(true);
  expect(
    remaining.findLast((message) => message.role === "user")?.content,
  ).toContain("Turn 12 says:");
  expect(
    after.filter(
      (event) =>
        event.type === "conversation/compacted" &&
        event.fromTurn === compacted.fromTurn &&
        event.throughTurn === compacted.throughTurn,
    ),
  ).toHaveLength(1);
  expect(
    (await calls()).filter(
      (call) => call.idempotencyKey === compacted.effectId,
    ),
  ).toHaveLength(1);
});
