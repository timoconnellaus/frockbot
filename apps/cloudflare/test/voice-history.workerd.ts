import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { VoiceAssistantHostV1 } from "@frockbot/app/voice/assistant";
import {
  renderVoiceBotHistoryV1,
  renderVoiceBotSearchV1,
} from "@frockbot/app/voice/history";
import { provisionBot } from "./provision-bot.ts";

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
    const adapter = instance as unknown as {
      turnHost(userId: string, turnId: string): VoiceAssistantHostV1;
    };
    const host = adapter.turnHost(identity.userId, "read-only");
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
  expect(await voice.probeChats()).toBe(0);
  expect(await voice.probeStorage("voice:delegation:")).toEqual({});

  const refused = await runInDurableObject(voice, async (instance) => {
    const adapter = instance as unknown as {
      turnHost(userId: string, turnId: string): VoiceAssistantHostV1;
    };
    const host = adapter.turnHost(identity.userId, "read-only");
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
