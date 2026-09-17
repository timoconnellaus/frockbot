import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { VoiceAssistantHostV1 } from "@frockbot/app/voice/assistant";
import {
  renderVoiceBotHistoryV1,
  renderVoiceBotSearchV1,
} from "@frockbot/app/voice/history";
import { provisionBot } from "./provision-bot.ts";

/**
 * The production host boundary, for the read-only tools alone.
 *
 * `turnHost` also grounds anything the turn remembers in the turn itself, so
 * it wants the live call the turn belongs to. These reads write nothing, so a
 * stand-in call is enough — and it keeps the tools under test reached the way
 * a real turn reaches them rather than through a second construction.
 */
function readOnlyHost(instance: unknown, userId: string): VoiceAssistantHostV1 {
  const adapter = instance as unknown as {
    turnHost(
      userId: string,
      call: { callId: string; startedAt: number; sequence: number },
      turnId: string,
      timezone?: string,
    ): VoiceAssistantHostV1;
  };
  const startedAt = Date.now();
  return adapter.turnHost(
    userId,
    { callId: "read-only", startedAt, sequence: startedAt },
    "read-only",
  );
}

test("voice reads and searches owned conversation records without admitting Bot work", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `history-${suffix}`,
    botId: `history-bot-${suffix}`,
  };
  const stranger = {
    userId: `stranger-${suffix}`,
    botId: `foreign-bot-${suffix}`,
  };
  await provisionBot(identity);
  await provisionBot(stranger);
  const bot = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  const runId = `launch-${suffix}`;
  await bot.run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: "launch status update",
    },
  });
  const query = { schemaVersion: 1, ...identity, query: { schemaVersion: 1 } };
  const before = JSON.parse(JSON.stringify(await bot.listRuns(query)));
  const voice = env.VOICE_ASSISTANTS.getByName(identity.userId);
  await voice.probeStorage("voice:delegation:");
  const result = await runInDurableObject(voice, async (instance) => {
    // Exercise the production host boundary without spending a voice model call.
    const host = readOnlyHost(instance, identity.userId);
    return {
      history: renderVoiceBotHistoryV1(
        await host.readBotHistory(identity.botId, 6),
      ),
      search: renderVoiceBotSearchV1(
        await host.searchBotHistory(identity.botId, "launch", 6),
      ),
      status: await host.botStatus(identity.botId),
    };
  });
  expect(
    JSON.parse(result.history).messages.some(
      (message: { runId: string }) => message.runId === runId,
    ),
  ).toBe(true);
  expect(
    JSON.parse(result.search).messages.some(
      (message: { runId: string }) => message.runId === runId,
    ),
  ).toBe(true);
  expect(result.status).toContain("completed");
  expect(JSON.parse(JSON.stringify(await bot.listRuns(query)))).toEqual(before);
  // Reading is reading: no session was opened and no Bot Turn was admitted.
  expect(await voice.probeUpstreamCount()).toBe(0);
  expect(await voice.probeStorage("voice:delegation:")).toEqual({});

  const refused = await runInDurableObject(voice, async (instance) => {
    const host = readOnlyHost(instance, identity.userId);
    return Promise.all(
      [
        () => host.readBotHistory(stranger.botId, 6),
        () => host.searchBotHistory(stranger.botId, "launch", 6),
        () => host.botStatus(stranger.botId),
      ].map(async (read) => {
        try {
          await read();
          return false;
        } catch (error) {
          return String(error).includes("not in this account");
        }
      }),
    );
  });
  expect(refused).toEqual([true, true, true]);
});

test("voice history reads the newest turns when a Bot has more than the limit", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `recent-${suffix}`,
    botId: `recent-bot-${suffix}`,
  };
  await provisionBot(identity);
  const bot = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  const turns = ["oldest question", "second question", "third question"];
  const runIds = turns.map((_, index) => `turn-${index}-${suffix}`);
  for (const [index, text] of turns.entries()) {
    await bot.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: runIds[index],
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date(Date.now() + index).toISOString(),
        text,
      },
    });
  }
  const voice = env.VOICE_ASSISTANTS.getByName(identity.userId);
  const history = await runInDurableObject(voice, async (instance) => {
    const host = readOnlyHost(instance, identity.userId);
    return renderVoiceBotHistoryV1(
      await host.readBotHistory(identity.botId, 1),
      1,
    );
  });
  const messages = JSON.parse(history).messages as {
    runId: string;
    text: string;
  }[];
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.map((message) => message.runId)).toEqual(
    messages.map(() => runIds[runIds.length - 1]),
  );
  expect(history).not.toContain("oldest question");
  expect(history).not.toContain("second question");
});
